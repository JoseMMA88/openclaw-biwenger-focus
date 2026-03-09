import type { AuctionSnapshot } from '../domain/focus.js';
import type { DailyMarketSnapshot } from '../domain/market.js';
import { BiwengerGateway } from '../gateway/BiwengerGateway.js';
import { Logger } from '../logger.js';
import { MarketReportService } from './MarketReportService.js';

interface MarketReportWorkerOptions {
  service: MarketReportService;
  gateway: BiwengerGateway;
  logger: Logger;
  tickSec: number;
  enabled: boolean;
  openingOnly: boolean;
}

export class MarketReportWorker {
  private readonly service: MarketReportService;
  private readonly gateway: BiwengerGateway;
  private readonly logger: Logger;
  private readonly tickSec: number;
  private readonly enabled: boolean;
  private readonly openingOnly: boolean;

  private timer: NodeJS.Timeout | null = null;
  private runningTick = false;
  private readonly playerNameCache = new Map<number, string>();

  constructor(options: MarketReportWorkerOptions) {
    this.service = options.service;
    this.gateway = options.gateway;
    this.logger = options.logger;
    this.tickSec = options.tickSec;
    this.enabled = options.enabled;
    this.openingOnly = options.openingOnly;
  }

  start(): void {
    if (!this.enabled) {
      this.logger.info('Market report worker disabled by config', {
        action: 'market_worker_disabled'
      });
      return;
    }

    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickSec * 1000);

    void this.tick();

    this.logger.info('Market report worker started', {
      action: 'market_worker_started',
      tick_sec: this.tickSec,
      opening_only: this.openingOnly
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;

    this.logger.info('Market report worker stopped', {
      action: 'market_worker_stopped'
    });
  }

  async runReportNow(force = false): Promise<boolean> {
    const data = await this.fetchMarketData();
    this.service.observeMarket(data);
    const report = await this.service.emitDailyReport(data, undefined, { force });
    return report !== null;
  }

  private async tick(): Promise<void> {
    if (this.runningTick) return;
    this.runningTick = true;

    try {
      if (this.openingOnly && !this.service.isDailyReportDue()) {
        return;
      }

      const data = await this.fetchMarketData();
      this.service.observeMarket(data);

      if (this.service.isDailyReportDue()) {
        await this.service.emitDailyReport(data);
      }
    } catch (error) {
      this.logger.warn('Market report tick failed', {
        action: 'market_worker_tick_failed',
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.runningTick = false;
    }
  }

  private async fetchMarketData(): Promise<{ auctions: AuctionSnapshot[]; daily: DailyMarketSnapshot[] }> {
    const auctions = await this.gateway.getAuctions();
    const daily = await this.gateway.getDailyMarket([], auctions.map((entry) => entry.playerId));

    await Promise.all([
      this.hydrateNames(auctions),
      this.hydrateNames(daily)
    ]);

    return { auctions, daily };
  }

  private async hydrateNames(entries: Array<{ playerId: number; playerName: string | null }>): Promise<void> {
    const missing = entries.filter((entry) => this.isMissingPlayerName(entry.playerName));
    if (missing.length === 0) return;

    await Promise.all(
      missing.map(async (entry) => {
        const cached = this.playerNameCache.get(entry.playerId);
        if (cached) {
          entry.playerName = cached;
          return;
        }

        try {
          const resolved = await this.gateway.getPlayerDisplayName(entry.playerId);
          if (resolved && resolved.trim().length > 0) {
            this.playerNameCache.set(entry.playerId, resolved);
            entry.playerName = resolved;
          }
        } catch (error) {
          this.logger.debug('Failed to resolve player display name', {
            action: 'market_player_name_resolve_failed',
            player_id: entry.playerId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })
    );
  }

  private isMissingPlayerName(playerName: string | null): boolean {
    if (!playerName) return true;
    const normalized = playerName.trim();
    if (normalized.length === 0) return true;
    return /^Player\s+\d+$/i.test(normalized);
  }
}
