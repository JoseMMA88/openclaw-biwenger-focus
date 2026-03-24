import { randomUUID } from 'node:crypto';

import { ClauseRepository } from '../db/ClauseRepository.js';
import type {
  ClauseRuntime,
  ClauseStatus,
  ClauseStatusResult,
  ClauseTask,
  CreateClauseScheduleInput,
  UpdateClauseScheduleInput
} from '../domain/clause.js';
import { ACTIVE_CLAUSE_STATUSES, FINAL_CLAUSE_STATUSES } from '../domain/clause.js';
import { BiwengerGateway } from '../gateway/BiwengerGateway.js';
import { Logger } from '../logger.js';
import type { Notifier } from '../notify/Notifier.js';
import { shortHash } from '../utils/hash.js';
import { nowSec } from '../utils/time.js';

export class ClauseError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ClauseError';
    this.code = code;
    this.details = details;
  }
}

interface CreateClauseOutput {
  clauseId: string;
  playerId: number;
  resolvedPlayerName: string;
  resolvedMaxClauseAmount: number;
  resolvedMaxClauseAmountSource: 'input' | 'current_clause';
  status: ClauseStatus;
  scheduledAt: number;
  secondsUntilExecution: number;
}

export class ClauseService {
  private readonly repo: ClauseRepository;
  private readonly gateway: BiwengerGateway;
  private readonly notifier: Notifier;
  private readonly logger: Logger;

  constructor(options: {
    repo: ClauseRepository;
    gateway: BiwengerGateway;
    notifier: Notifier;
    logger: Logger;
  }) {
    this.repo = options.repo;
    this.gateway = options.gateway;
    this.notifier = options.notifier;
    this.logger = options.logger;
  }

  async createSchedule(input: CreateClauseScheduleInput): Promise<CreateClauseOutput> {
    const playerQuery = input.playerQuery.trim();
    if (!playerQuery) {
      throw new ClauseError('VALIDATION_ERROR', 'player_query no puede estar vacío.');
    }

    const executeAt = this.requireFutureEpoch(input.executeAt, 'execute_at');

    const matches = await this.gateway.searchPlayerByName(playerQuery, input.competition);
    if (matches.length === 0) {
      throw new ClauseError('PLAYER_NOT_FOUND', `No se encontró jugador para: ${playerQuery}`);
    }

    const bestMatch = this.pickBestMatch(playerQuery, matches);
    const resolvedMaxClauseAmount = await this.resolveMaxClauseAmount(input.maxClauseAmount, bestMatch.id, input.competition);
    const resolvedMaxClauseAmountSource: 'input' | 'current_clause' = input.maxClauseAmount !== undefined
      ? 'input'
      : 'current_clause';
    const active = this.repo.getActiveTaskByPlayerId(bestMatch.id);
    if (active) {
      throw new ClauseError('CLAUSE_CONFLICT', 'Ya existe una cláusula programada activa para este jugador.', {
        clause_id: active.id,
        player_id: active.playerId
      });
    }

    const created = this.repo.createTask({
      id: randomUUID(),
      playerQuery,
      playerId: bestMatch.id,
      playerName: bestMatch.name,
      competition: input.competition?.trim() || null,
      maxClauseAmount: resolvedMaxClauseAmount,
      scheduledAt: executeAt
    });

    await this.emitEvent(
      created.id,
      'clause_scheduled',
      `🧨 Clausulazo programado para ${created.playerName} (tope ${created.maxClauseAmount.toLocaleString('es-ES')}).`,
      {
        clause_id: created.id,
        player_id: created.playerId,
        player_name: created.playerName,
        scheduled_at: created.scheduledAt,
        max_clause_amount: created.maxClauseAmount
      }
    );

    return {
      clauseId: created.id,
      playerId: created.playerId,
      resolvedPlayerName: created.playerName,
      resolvedMaxClauseAmount: created.maxClauseAmount,
      resolvedMaxClauseAmountSource,
      status: created.status,
      scheduledAt: created.scheduledAt,
      secondsUntilExecution: Math.max(0, created.scheduledAt - nowSec())
    };
  }

  getStatus(input: { clauseId?: string; playerQuery?: string }): ClauseStatusResult {
    const task = this.findTask(input);
    const runtime = this.repo.getRuntime(task.id);

    return {
      task,
      runtime,
      secondsUntilExecution: ACTIVE_CLAUSE_STATUSES.includes(task.status as (typeof ACTIVE_CLAUSE_STATUSES)[number])
        ? Math.max(0, task.nextRunAt - nowSec())
        : null
    };
  }

  list(status?: ClauseStatus, limit = 50): ClauseTask[] {
    return this.repo.listTasks(status, limit);
  }

  updateSchedule(input: UpdateClauseScheduleInput): ClauseTask {
    const clauseId = input.clauseId.trim();
    if (!clauseId) {
      throw new ClauseError('VALIDATION_ERROR', 'clause_id es obligatorio.');
    }

    const task = this.repo.getTaskById(clauseId);
    if (!task) {
      throw new ClauseError('CLAUSE_NOT_FOUND', `No existe clause_id=${clauseId}`);
    }

    if (FINAL_CLAUSE_STATUSES.includes(task.status as (typeof FINAL_CLAUSE_STATUSES)[number])) {
      throw new ClauseError('VALIDATION_ERROR', 'No se puede editar una cláusula finalizada.');
    }

    const updated = this.repo.updateTaskConfig(clauseId, {
      maxClauseAmount: input.maxClauseAmount !== undefined
        ? this.requirePositiveInt(input.maxClauseAmount, 'max_clause_amount')
        : undefined,
      scheduledAt: input.executeAt !== undefined
        ? this.requireFutureEpoch(input.executeAt, 'execute_at')
        : undefined
    });

    this.logger.info('Clause schedule updated', {
      action: 'clause_updated',
      clause_id: updated.id,
      player_id: updated.playerId
    });

    return updated;
  }

  async cancelSchedule(clauseId: string): Promise<ClauseTask> {
    const task = this.repo.getTaskById(clauseId);
    if (!task) {
      throw new ClauseError('CLAUSE_NOT_FOUND', `No existe clause_id=${clauseId}`);
    }

    if (FINAL_CLAUSE_STATUSES.includes(task.status as (typeof FINAL_CLAUSE_STATUSES)[number])) {
      return task;
    }

    const cancelled = this.repo.setTaskStatus(clauseId, 'CANCELLED', 'cancelled_by_user');

    await this.emitEvent(
      clauseId,
      'clause_cancelled',
      `⛔ Clausulazo cancelado para ${task.playerName}.`,
      {
        clause_id: clauseId,
        player_id: task.playerId,
        status: cancelled.status
      }
    );

    return cancelled;
  }

  claimDueTasks(limit: number, lockTtlSec: number): ClauseTask[] {
    return this.repo.claimDueTasks(limit, lockTtlSec);
  }

  releaseTaskLock(clauseId: string): void {
    this.repo.releaseLock(clauseId);
  }

  getTaskById(clauseId: string): ClauseTask | null {
    return this.repo.getTaskById(clauseId);
  }

  getRuntime(clauseId: string): ClauseRuntime {
    return this.repo.getRuntime(clauseId);
  }

  patchRuntime(clauseId: string, patch: Partial<ClauseRuntime>): ClauseRuntime {
    return this.repo.patchRuntime(clauseId, patch);
  }

  setStatus(clauseId: string, status: ClauseStatus, reason: string | null = null): ClauseTask {
    return this.repo.setTaskStatus(clauseId, status, reason);
  }

  setNextRunAt(clauseId: string, atSec: number): void {
    this.repo.setNextRunAt(clauseId, atSec);
  }

  async emitEvent(
    clauseId: string,
    eventType: string,
    text: string,
    payload: Record<string, unknown>,
    dedupeWindowSec?: number
  ): Promise<void> {
    const eventHash = shortHash({ eventType, text, payload });

    const inserted = this.repo.appendEvent({
      clauseId,
      eventType,
      eventHash,
      payloadJson: JSON.stringify(payload),
      dedupeWindowSec
    });

    if (!inserted) return;

    await this.notifier.notify({
      focusId: clauseId,
      eventType,
      text,
      payload
    });
  }

  private findTask(input: { clauseId?: string; playerQuery?: string }): ClauseTask {
    if (input.clauseId) {
      const task = this.repo.getTaskById(input.clauseId);
      if (!task) {
        throw new ClauseError('CLAUSE_NOT_FOUND', `No existe clause_id=${input.clauseId}`);
      }
      return task;
    }

    if (input.playerQuery) {
      const task = this.repo.getTaskByPlayerQuery(input.playerQuery.trim());
      if (!task) {
        throw new ClauseError('CLAUSE_NOT_FOUND', `No se encontró cláusula para query=${input.playerQuery}`);
      }
      return task;
    }

    throw new ClauseError('VALIDATION_ERROR', 'Debes indicar clause_id o player_query.');
  }

  private requirePositiveInt(value: number, field: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ClauseError('VALIDATION_ERROR', `${field} debe ser entero positivo.`);
    }
    return parsed;
  }

  private async resolveMaxClauseAmount(
    maxClauseAmount: number | undefined,
    playerId: number,
    competition?: string
  ): Promise<number> {
    if (maxClauseAmount !== undefined) {
      return this.requirePositiveInt(maxClauseAmount, 'max_clause_amount');
    }

    const clauseInfo = await this.gateway.getPlayerClauseInfo(playerId, competition);
    if (!clauseInfo.clauseAmount || clauseInfo.clauseAmount <= 0) {
      const playerLabel = clauseInfo.playerName ?? `player_id=${playerId}`;

      if (!clauseInfo.ownerUserId) {
        throw new ClauseError(
          'CLAUSE_NOT_AVAILABLE',
          `No se pudo resolver la cláusula actual de ${playerLabel}: el jugador aparece sin owner en la liga ahora mismo (podría estar libre). Indica max_clause_amount manualmente.`,
          {
            reason: 'owner_not_found',
            player_id: playerId,
            player_name: clauseInfo.playerName,
            owner_user_id: null
          }
        );
      }

      let myUserId: number | null = null;
      try {
        const roster = await this.gateway.getMyUserRoster();
        myUserId = roster.userId;
      } catch {
        myUserId = null;
      }

      if (myUserId && clauseInfo.ownerUserId === myUserId) {
        throw new ClauseError(
          'CLAUSE_NOT_AVAILABLE',
          `No se puede usar "cláusula actual" para ${playerLabel} porque el jugador ya pertenece a tu equipo.`,
          {
            reason: 'player_already_owned_by_me',
            player_id: playerId,
            player_name: clauseInfo.playerName,
            owner_user_id: clauseInfo.ownerUserId,
            my_user_id: myUserId
          }
        );
      }

      throw new ClauseError(
        'CLAUSE_NOT_AVAILABLE',
        `No se pudo resolver la cláusula actual de ${playerLabel}: owner_user_id=${clauseInfo.ownerUserId} pero sin importe de cláusula visible. Indica max_clause_amount manualmente.`,
        {
          reason: 'clause_amount_missing',
          player_id: playerId,
          player_name: clauseInfo.playerName,
          owner_user_id: clauseInfo.ownerUserId
        }
      );
    }

    return this.requirePositiveInt(clauseInfo.clauseAmount, 'max_clause_amount');
  }

  private requireFutureEpoch(value: number, field: string): number {
    const parsed = this.requirePositiveInt(value, field);
    const now = nowSec();

    if (parsed <= now) {
      throw new ClauseError('VALIDATION_ERROR', `${field} debe estar en el futuro.`);
    }

    return parsed;
  }

  private pickBestMatch(
    query: string,
    matches: Array<{ id: number; name: string; teamName: string | null }>
  ): { id: number; name: string; teamName: string | null } {
    const normalizedQuery = query.trim().toLowerCase();

    const exact = matches.find((entry) => entry.name.trim().toLowerCase() === normalizedQuery);
    if (exact) return exact;

    const startsWith = matches.find((entry) => entry.name.trim().toLowerCase().startsWith(normalizedQuery));
    if (startsWith) return startsWith;

    return matches[0];
  }
}
