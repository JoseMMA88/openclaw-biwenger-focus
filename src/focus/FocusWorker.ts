import type { AuctionSnapshot, FocusTask } from '../domain/focus.js';
import { BiwengerGateway } from '../gateway/BiwengerGateway.js';
import { Logger } from '../logger.js';
import { nowSec } from '../utils/time.js';
import { decideBidAction } from './strategy.js';
import { FocusService } from './FocusService.js';

interface FocusWorkerOptions {
  service: FocusService;
  gateway: BiwengerGateway;
  logger: Logger;
  lockTtlSec: number;
  missingTimeoutSec: number;
  tickSec: number;
  maxConsecutiveErrors: number;
  biddingPollSec: number;
}

interface RosterCache {
  userId: number | null;
  playerIds: Set<number>;
  fetchedAt: number;
}

export class FocusWorker {
  private readonly service: FocusService;
  private readonly gateway: BiwengerGateway;
  private readonly logger: Logger;
  private readonly lockTtlSec: number;
  private readonly missingTimeoutSec: number;
  private readonly tickSec: number;
  private readonly maxConsecutiveErrors: number;
  private readonly biddingPollSec: number;

  private timer: NodeJS.Timeout | null = null;
  private runningTick = false;
  private rosterCache: RosterCache | null = null;

  constructor(options: FocusWorkerOptions) {
    this.service = options.service;
    this.gateway = options.gateway;
    this.logger = options.logger;
    this.lockTtlSec = options.lockTtlSec;
    this.missingTimeoutSec = options.missingTimeoutSec;
    this.tickSec = options.tickSec;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors;
    this.biddingPollSec = options.biddingPollSec;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickSec * 1000);

    void this.tick();

    this.logger.info('Focus worker started', {
      action: 'worker_started',
      tick_sec: this.tickSec
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;

    this.logger.info('Focus worker stopped', {
      action: 'worker_stopped'
    });
  }

  private async tick(): Promise<void> {
    if (this.runningTick) return;
    this.runningTick = true;

    try {
      const tasks = this.service.claimDueTasks(20, this.lockTtlSec);
      if (tasks.length === 0) return;

      const auctions = await this.gateway.getAuctions();
      const auctionByPlayer = new Map<number, AuctionSnapshot>();
      for (const auction of auctions) {
        auctionByPlayer.set(auction.playerId, auction);
      }

      for (const task of tasks) {
        try {
          await this.processTask(task, auctionByPlayer.get(task.playerId) ?? null);
        } catch (error) {
          await this.handleTaskError(task, error);
        } finally {
          this.service.releaseTaskLock(task.id);
        }
      }
    } catch (error) {
      this.logger.error('Worker tick failed', {
        action: 'worker_tick_failed',
        error: this.toErrorMessage(error)
      });
    } finally {
      this.runningTick = false;
    }
  }

  private async processTask(task: FocusTask, auction: AuctionSnapshot | null): Promise<void> {
    const now = nowSec();
    const runtime = this.service.getRuntime(task.id);

    if (!auction) {
      await this.handleMissingAuction(task, runtime.lastSeenUntil, runtime.missingSince);
      return;
    }

    const me = await this.getRosterCached();
    const isHighest = me.userId !== null
      && auction.highestBidderUserId !== null
      && me.userId === auction.highestBidderUserId;

    const patchedRuntime = this.service.patchRuntime(task.id, {
      lastSeenPrice: auction.currentPrice,
      lastSeenUntil: auction.until,
      missingSince: null,
      ownerUserId: auction.highestBidderUserId,
      isCurrentHighestBidder: isHighest,
      myUserId: me.userId,
      consecutiveErrors: 0,
      lastError: null
    });

    if (auction.until !== null && auction.until <= now) {
      await this.settleAuction(task, me.playerIds);
      return;
    }

    const decision = decideBidAction({
      nowSec: now,
      task,
      runtime: patchedRuntime,
      auction,
      isCurrentHighestBidder: isHighest
    });

    if (decision.remainingSec !== null && decision.remainingSec <= task.startWhenRemainingSec && task.status !== 'BIDDING') {
      await this.service.emitEvent(
        task.id,
        'bidding_window_started',
        `⏱️ Ventana de puja activa para ${task.playerName}.`,
        {
          focus_id: task.id,
          player_id: task.playerId,
          remaining_sec: decision.remainingSec
        }
      );
    }

    switch (decision.action) {
      case 'MONITOR_ARMED': {
        if (task.status !== 'ARMED') {
          this.service.setStatus(task.id, 'ARMED');
        }

        this.service.setNextPollAt(task.id, now + task.pollSec);
        await this.service.emitMonitoringHeartbeat(task);
        return;
      }

      case 'MONITOR_BIDDING':
      case 'WAIT_COOLDOWN': {
        if (task.status !== 'BIDDING') {
          this.service.setStatus(task.id, 'BIDDING');
        }

        if (
          patchedRuntime.lastBidAmount !== null
          && auction.currentPrice !== null
          && auction.currentPrice > patchedRuntime.lastBidAmount
          && patchedRuntime.myUserId !== null
          && auction.highestBidderUserId !== null
          && auction.highestBidderUserId !== patchedRuntime.myUserId
          && !isHighest
        ) {
          await this.service.emitEvent(
            task.id,
            'overbid_detected',
            `⚠️ Sobrepuja detectada en ${task.playerName}: ${auction.currentPrice.toLocaleString('es-ES')}.`,
            {
              focus_id: task.id,
              player_id: task.playerId,
              current_price: auction.currentPrice,
              last_bid_amount: patchedRuntime.lastBidAmount,
              highest_bidder_user_id: auction.highestBidderUserId,
              my_user_id: patchedRuntime.myUserId
            },
            300
          );
        }

        this.service.setNextPollAt(task.id, now + this.resolveBiddingPollSec(task));
        return;
      }

      case 'MAX_REACHED': {
        this.service.setStatus(task.id, 'COMPLETED_LOST', 'max_reached');
        this.service.setNextPollAt(task.id, now + task.pollSec);

        await this.service.emitEvent(
          task.id,
          'focus_completed_lost',
          `🛑 Límite alcanzado para ${task.playerName}. No se enviarán más pujas.`,
          {
            focus_id: task.id,
            player_id: task.playerId,
            max_price: task.maxPrice,
            next_bid_amount: decision.targetBid
          }
        );
        return;
      }

      case 'PLACE_BID': {
        if (decision.targetBid === null) {
          this.service.setNextPollAt(task.id, now + task.pollSec);
          return;
        }

        // Failsafe: never bid if the current highest bid is already ours.
        if (
          patchedRuntime.myUserId !== null
          && patchedRuntime.ownerUserId !== null
          && patchedRuntime.myUserId === patchedRuntime.ownerUserId
        ) {
          this.service.setStatus(task.id, 'BIDDING');
          this.service.setNextPollAt(task.id, now + task.pollSec);
          return;
        }

        await this.gateway.placeBid(task.playerId, decision.targetBid);

        this.service.patchRuntime(task.id, {
          lastBidAmount: decision.targetBid,
          lastBidAt: now,
          consecutiveErrors: 0,
          lastError: null
        });

        this.service.setStatus(task.id, 'BIDDING');
        this.service.setNextPollAt(task.id, now + this.resolveBiddingPollSec(task));

        await this.service.emitEvent(
          task.id,
          'bid_placed',
          `💸 Puja enviada por ${task.playerName}: ${decision.targetBid.toLocaleString('es-ES')}.`,
          {
            focus_id: task.id,
            player_id: task.playerId,
            amount: decision.targetBid,
            remaining_sec: decision.remainingSec,
            max_price: task.maxPrice
          }
        );
        return;
      }

      case 'MISSING_AUCTION': {
        await this.handleMissingAuction(task, patchedRuntime.lastSeenUntil, patchedRuntime.missingSince);
        return;
      }
    }
  }

  private resolveBiddingPollSec(task: FocusTask): number {
    return Math.max(task.pollSec, this.biddingPollSec);
  }

  private async handleMissingAuction(task: FocusTask, lastSeenUntil: number | null, missingSince: number | null): Promise<void> {
    const now = nowSec();

    if (task.status === 'CANCELLED') {
      this.service.setNextPollAt(task.id, now + task.pollSec);
      return;
    }

    const startedMissingAt = missingSince ?? now;
    this.service.patchRuntime(task.id, {
      missingSince: startedMissingAt
    });

    const me = await this.getRosterCached();
    if (me.playerIds.has(task.playerId)) {
      this.service.setStatus(task.id, 'COMPLETED_WON', 'player_in_my_roster');
      await this.service.emitEvent(
        task.id,
        'focus_completed_won',
        `🏆 Subasta ganada para ${task.playerName}.`,
        {
          focus_id: task.id,
          player_id: task.playerId
        }
      );
      return;
    }

    if (lastSeenUntil !== null && now > lastSeenUntil + 15) {
      this.service.setStatus(task.id, 'COMPLETED_LOST', 'auction_finished_not_owned');
      await this.service.emitEvent(
        task.id,
        'focus_completed_lost',
        `❌ Subasta finalizada sin ganar ${task.playerName}.`,
        {
          focus_id: task.id,
          player_id: task.playerId
        }
      );
      return;
    }

    if (now - startedMissingAt > this.missingTimeoutSec) {
      this.service.setStatus(task.id, 'FAILED', 'auction_missing_timeout');
      await this.service.emitEvent(
        task.id,
        'focus_failed',
        `🚨 Foco fallido para ${task.playerName}: subasta ausente > ${this.missingTimeoutSec}s.`,
        {
          focus_id: task.id,
          player_id: task.playerId,
          missing_timeout_sec: this.missingTimeoutSec
        }
      );
      return;
    }

    this.service.setNextPollAt(task.id, now + task.pollSec);
  }

  private async settleAuction(task: FocusTask, roster: Set<number>): Promise<void> {
    const now = nowSec();

    if (roster.has(task.playerId)) {
      this.service.setStatus(task.id, 'COMPLETED_WON', 'player_in_my_roster');
      await this.service.emitEvent(
        task.id,
        'focus_completed_won',
        `🏆 Subasta ganada para ${task.playerName}.`,
        {
          focus_id: task.id,
          player_id: task.playerId
        }
      );
      return;
    }

    this.service.setStatus(task.id, 'COMPLETED_LOST', 'auction_finished_not_owned');
    this.service.setNextPollAt(task.id, now + task.pollSec);

    await this.service.emitEvent(
      task.id,
      'focus_completed_lost',
      `❌ Subasta perdida para ${task.playerName}.`,
      {
        focus_id: task.id,
        player_id: task.playerId
      }
    );
  }

  private async handleTaskError(task: FocusTask, error: unknown): Promise<void> {
    const now = nowSec();
    const runtime = this.service.getRuntime(task.id);
    const nextErrorCount = runtime.consecutiveErrors + 1;
    const errorMessage = this.toErrorMessage(error);

    this.service.patchRuntime(task.id, {
      consecutiveErrors: nextErrorCount,
      lastError: errorMessage
    });

    if (nextErrorCount >= this.maxConsecutiveErrors) {
      this.service.setStatus(task.id, 'FAILED', 'too_many_errors');

      await this.service.emitEvent(
        task.id,
        'focus_failed',
        `🚨 Foco fallido para ${task.playerName} tras ${nextErrorCount} errores consecutivos.`,
        {
          focus_id: task.id,
          player_id: task.playerId,
          error: errorMessage,
          consecutive_errors: nextErrorCount
        }
      );

      return;
    }

    const backoffSec = Math.min(task.pollSec + nextErrorCount * 5, 120);
    this.service.setNextPollAt(task.id, now + backoffSec);

    if (nextErrorCount === 1 || nextErrorCount % 3 === 0) {
      await this.service.emitEvent(
        task.id,
        'focus_error',
        `⚠️ Error en foco ${task.playerName}: ${errorMessage}`,
        {
          focus_id: task.id,
          player_id: task.playerId,
          consecutive_errors: nextErrorCount,
          backoff_sec: backoffSec
        },
        300
      );
    }

    this.logger.warn('Focus task error', {
      action: 'focus_task_error',
      focus_id: task.id,
      player_id: task.playerId,
      error: errorMessage,
      consecutive_errors: nextErrorCount
    });
  }

  private async getRosterCached(force = false): Promise<{ userId: number | null; playerIds: Set<number> }> {
    const now = nowSec();
    if (!force && this.rosterCache && now - this.rosterCache.fetchedAt < 30) {
      return {
        userId: this.rosterCache.userId,
        playerIds: new Set(this.rosterCache.playerIds)
      };
    }

    const roster = await this.gateway.getMyUserRoster();
    this.rosterCache = {
      userId: roster.userId,
      playerIds: new Set(roster.playerIds),
      fetchedAt: now
    };

    return {
      userId: this.rosterCache.userId,
      playerIds: new Set(this.rosterCache.playerIds)
    };
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
