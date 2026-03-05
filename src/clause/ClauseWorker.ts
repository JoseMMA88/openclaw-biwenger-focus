import type { ClauseTask } from '../domain/clause.js';
import { BiwengerGateway } from '../gateway/BiwengerGateway.js';
import { Logger } from '../logger.js';
import { nowSec } from '../utils/time.js';
import { ClauseService } from './ClauseService.js';

interface ClauseWorkerOptions {
  service: ClauseService;
  gateway: BiwengerGateway;
  logger: Logger;
  lockTtlSec: number;
  tickSec: number;
  maxConsecutiveErrors: number;
}

export class ClauseWorker {
  private readonly service: ClauseService;
  private readonly gateway: BiwengerGateway;
  private readonly logger: Logger;
  private readonly lockTtlSec: number;
  private readonly tickSec: number;
  private readonly maxConsecutiveErrors: number;

  private timer: NodeJS.Timeout | null = null;
  private runningTick = false;

  constructor(options: ClauseWorkerOptions) {
    this.service = options.service;
    this.gateway = options.gateway;
    this.logger = options.logger;
    this.lockTtlSec = options.lockTtlSec;
    this.tickSec = options.tickSec;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickSec * 1000);

    void this.tick();

    this.logger.info('Clause worker started', {
      action: 'clause_worker_started',
      tick_sec: this.tickSec
    });
  }

  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;

    this.logger.info('Clause worker stopped', {
      action: 'clause_worker_stopped'
    });
  }

  private async tick(): Promise<void> {
    if (this.runningTick) return;
    this.runningTick = true;

    try {
      const tasks = this.service.claimDueTasks(20, this.lockTtlSec);
      if (tasks.length === 0) return;

      for (const task of tasks) {
        try {
          await this.processTask(task);
        } catch (error) {
          await this.handleTaskError(task, error);
        } finally {
          this.service.releaseTaskLock(task.id);
        }
      }
    } catch (error) {
      this.logger.error('Clause worker tick failed', {
        action: 'clause_worker_tick_failed',
        error: this.toErrorMessage(error)
      });
    } finally {
      this.runningTick = false;
    }
  }

  private async processTask(task: ClauseTask): Promise<void> {
    const now = nowSec();

    if (task.scheduledAt > now) {
      this.service.setNextRunAt(task.id, task.scheduledAt);
      return;
    }

    if (task.status !== 'EXECUTING') {
      this.service.setStatus(task.id, 'EXECUTING');
    }

    const clauseInfo = await this.gateway.getPlayerClauseInfo(task.playerId, task.competition ?? undefined);

    const clauseAmount = clauseInfo.clauseAmount;
    const ownerUserId = clauseInfo.ownerUserId;
    if (!clauseAmount || clauseAmount <= 0) {
      throw new Error('No se pudo resolver importe de cláusula del jugador.');
    }

    this.service.patchRuntime(task.id, {
      lastSeenClauseAmount: clauseAmount,
      lastSeenOwnerUserId: ownerUserId,
      consecutiveErrors: 0,
      lastError: null
    });

    if (!ownerUserId) {
      throw new Error('No se pudo resolver owner_user_id para ejecutar cláusula.');
    }

    if (clauseAmount > task.maxClauseAmount) {
      this.service.setStatus(task.id, 'COMPLETED_SKIPPED_MAX', 'max_clause_exceeded');

      await this.service.emitEvent(
        task.id,
        'clause_skipped_max',
        `🛑 Clausulazo omitido en ${task.playerName}: ${clauseAmount.toLocaleString('es-ES')} > tope ${task.maxClauseAmount.toLocaleString('es-ES')}.`,
        {
          clause_id: task.id,
          player_id: task.playerId,
          player_name: task.playerName,
          clause_amount: clauseAmount,
          max_clause_amount: task.maxClauseAmount
        }
      );

      return;
    }

    await this.gateway.payClause(task.playerId, ownerUserId, clauseAmount);

    this.service.patchRuntime(task.id, {
      executedAmount: clauseAmount,
      consecutiveErrors: 0,
      lastError: null
    });

    this.service.setStatus(task.id, 'COMPLETED_EXECUTED', 'clause_paid');

    await this.service.emitEvent(
      task.id,
      'clause_executed',
      `✅ Clausulazo ejecutado para ${task.playerName}: ${clauseAmount.toLocaleString('es-ES')}.`,
      {
        clause_id: task.id,
        player_id: task.playerId,
        player_name: task.playerName,
        amount: clauseAmount,
        max_clause_amount: task.maxClauseAmount,
        owner_user_id: ownerUserId
      }
    );
  }

  private async handleTaskError(task: ClauseTask, error: unknown): Promise<void> {
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
        'clause_failed',
        `🚨 Clausulazo fallido para ${task.playerName} tras ${nextErrorCount} errores consecutivos.`,
        {
          clause_id: task.id,
          player_id: task.playerId,
          error: errorMessage,
          consecutive_errors: nextErrorCount
        }
      );

      return;
    }

    const backoffSec = Math.min(10 + nextErrorCount * 20, 300);
    this.service.setStatus(task.id, 'EXECUTING');
    this.service.setNextRunAt(task.id, now + backoffSec);

    if (nextErrorCount === 1 || nextErrorCount % 3 === 0) {
      await this.service.emitEvent(
        task.id,
        'clause_error',
        `⚠️ Error en clausulazo ${task.playerName}: ${errorMessage}`,
        {
          clause_id: task.id,
          player_id: task.playerId,
          consecutive_errors: nextErrorCount,
          backoff_sec: backoffSec
        },
        300
      );
    }

    this.logger.warn('Clause task error', {
      action: 'clause_task_error',
      clause_id: task.id,
      player_id: task.playerId,
      error: errorMessage,
      consecutive_errors: nextErrorCount
    });
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
