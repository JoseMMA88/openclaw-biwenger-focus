import { randomUUID } from 'node:crypto';

import { FocusRepository } from '../db/FocusRepository.js';
import type {
  CreateFocusInput,
  FocusRuntime,
  FocusStatus,
  FocusStatusResult,
  FocusTask,
  UpdateFocusInput
} from '../domain/focus.js';
import { ACTIVE_STATUSES, FINAL_STATUSES } from '../domain/focus.js';
import { BiwengerGateway } from '../gateway/BiwengerGateway.js';
import { Logger } from '../logger.js';
import type { Notifier } from '../notify/Notifier.js';
import { shortHash } from '../utils/hash.js';
import { nowSec } from '../utils/time.js';

export class FocusError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FocusError';
    this.code = code;
    this.details = details;
  }
}

interface CreateFocusOutput {
  focusId: string;
  playerId: number;
  resolvedPlayerName: string;
  status: FocusStatus;
  auctionUntil: number | null;
  currentPrice: number | null;
}

export class FocusService {
  private readonly repo: FocusRepository;
  private readonly gateway: BiwengerGateway;
  private readonly notifier: Notifier;
  private readonly logger: Logger;
  private readonly defaults: {
    startWhenRemainingSec: number;
    bidStep: number;
    pollSec: number;
    cooldownSec: number;
  };

  constructor(options: {
    repo: FocusRepository;
    gateway: BiwengerGateway;
    notifier: Notifier;
    logger: Logger;
    defaults: {
      startWhenRemainingSec: number;
      bidStep: number;
      pollSec: number;
      cooldownSec: number;
    };
  }) {
    this.repo = options.repo;
    this.gateway = options.gateway;
    this.notifier = options.notifier;
    this.logger = options.logger;
    this.defaults = options.defaults;
  }

  async createFocus(input: CreateFocusInput): Promise<CreateFocusOutput> {
    const playerQuery = input.playerQuery.trim();
    if (!playerQuery) {
      throw new FocusError('VALIDATION_ERROR', 'player_query no puede estar vacío.');
    }

    const maxPrice = this.requirePositiveInt(input.maxPrice, 'max_price');

    const startWhenRemainingSec = this.requirePositiveInt(
      input.startWhenRemainingSec ?? this.defaults.startWhenRemainingSec,
      'start_when_remaining_sec'
    );
    const bidStep = this.requirePositiveInt(input.bidStep ?? this.defaults.bidStep, 'bid_step');
    const pollSec = this.requirePositiveInt(input.pollSec ?? this.defaults.pollSec, 'poll_sec');
    const cooldownSec = this.requirePositiveInt(input.cooldownSec ?? this.defaults.cooldownSec, 'cooldown_sec');

    const matches = await this.gateway.searchPlayerByName(playerQuery, input.competition);
    if (matches.length === 0) {
      throw new FocusError('PLAYER_NOT_FOUND', `No se encontró jugador para: ${playerQuery}`);
    }

    const bestMatch = this.pickBestMatch(playerQuery, matches);

    const existing = this.repo.getActiveTaskByPlayerId(bestMatch.id);
    if (existing) {
      throw new FocusError('FOCUS_CONFLICT', 'Ya existe un foco activo para este jugador.', {
        focus_id: existing.id,
        player_id: existing.playerId
      });
    }

    const auctions = await this.gateway.getAuctions();
    const auction = auctions.find((entry) => entry.playerId === bestMatch.id) ?? null;

    const created = this.repo.createTask({
      id: randomUUID(),
      playerQuery,
      playerId: bestMatch.id,
      playerName: bestMatch.name,
      competition: input.competition?.trim() || null,
      maxPrice,
      startWhenRemainingSec,
      bidStep,
      pollSec,
      cooldownSec
    });

    await this.emitEvent(
      created.id,
      'focus_created',
      `🎯 Foco creado para ${created.playerName} (max ${created.maxPrice.toLocaleString('es-ES')}).`,
      {
        focus_id: created.id,
        player_id: created.playerId,
        player_name: created.playerName,
        max_price: created.maxPrice,
        bid_step: created.bidStep,
        start_when_remaining_sec: created.startWhenRemainingSec
      }
    );

    return {
      focusId: created.id,
      playerId: created.playerId,
      resolvedPlayerName: created.playerName,
      status: created.status,
      auctionUntil: auction?.until ?? null,
      currentPrice: auction?.currentPrice ?? null
    };
  }

  getStatus(input: { focusId?: string; playerQuery?: string }): FocusStatusResult {
    const task = this.findTask(input);
    const runtime = this.repo.getRuntime(task.id);

    const remainingSec = runtime.lastSeenUntil === null ? null : runtime.lastSeenUntil - nowSec();
    const nextBidAmount = (() => {
      if (runtime.lastSeenPrice === null) return null;
      if (runtime.lastBidAmount === null) return runtime.lastSeenPrice;
      if (runtime.lastSeenPrice > runtime.lastBidAmount) return runtime.lastSeenPrice;
      return null;
    })();

    return {
      task,
      runtime,
      remainingSec,
      nextBidAmount
    };
  }

  list(status?: FocusStatus, limit = 50): FocusTask[] {
    return this.repo.listTasks(status, limit);
  }

  updateFocus(input: UpdateFocusInput): FocusTask {
    if (input.focusId.trim().length === 0) {
      throw new FocusError('VALIDATION_ERROR', 'focus_id es obligatorio.');
    }
    const task = this.repo.getTaskById(input.focusId);
    if (!task) {
      throw new FocusError('FOCUS_NOT_FOUND', `No existe focus_id=${input.focusId}`);
    }

    if (FINAL_STATUSES.includes(task.status as (typeof FINAL_STATUSES)[number])) {
      throw new FocusError('VALIDATION_ERROR', 'No se puede editar un foco finalizado.');
    }

    const updated = this.repo.updateTaskConfig(input.focusId, {
      maxPrice: input.maxPrice !== undefined ? this.requirePositiveInt(input.maxPrice, 'max_price') : undefined,
      startWhenRemainingSec: input.startWhenRemainingSec !== undefined
        ? this.requirePositiveInt(input.startWhenRemainingSec, 'start_when_remaining_sec')
        : undefined,
      bidStep: input.bidStep !== undefined ? this.requirePositiveInt(input.bidStep, 'bid_step') : undefined,
      pollSec: input.pollSec !== undefined ? this.requirePositiveInt(input.pollSec, 'poll_sec') : undefined,
      cooldownSec: input.cooldownSec !== undefined ? this.requirePositiveInt(input.cooldownSec, 'cooldown_sec') : undefined
    });

    this.logger.info('Focus updated', {
      action: 'focus_updated',
      focus_id: updated.id,
      player_id: updated.playerId
    });

    return updated;
  }

  async cancelFocus(focusId: string): Promise<FocusTask> {
    const task = this.repo.getTaskById(focusId);
    if (!task) {
      throw new FocusError('FOCUS_NOT_FOUND', `No existe focus_id=${focusId}`);
    }

    if (FINAL_STATUSES.includes(task.status as (typeof FINAL_STATUSES)[number])) {
      return task;
    }

    const updated = this.repo.setTaskStatus(focusId, 'CANCELLED', 'cancelled_by_user');

    await this.emitEvent(
      focusId,
      'focus_cancelled',
      `⛔ Foco cancelado para ${task.playerName}.`,
      {
        focus_id: focusId,
        player_id: task.playerId,
        status: updated.status
      }
    );

    return updated;
  }

  claimDueTasks(limit: number, lockTtlSec: number): FocusTask[] {
    return this.repo.claimDueTasks(limit, lockTtlSec);
  }

  releaseTaskLock(focusId: string): void {
    this.repo.releaseLock(focusId);
  }

  getTaskById(focusId: string): FocusTask | null {
    return this.repo.getTaskById(focusId);
  }

  getRuntime(focusId: string): FocusRuntime {
    return this.repo.getRuntime(focusId);
  }

  patchRuntime(focusId: string, patch: Partial<FocusRuntime>): FocusRuntime {
    return this.repo.patchRuntime(focusId, patch);
  }

  setStatus(focusId: string, status: FocusStatus, reason: string | null = null): FocusTask {
    return this.repo.setTaskStatus(focusId, status, reason);
  }

  setNextPollAt(focusId: string, atSec: number): void {
    this.repo.setNextPollAt(focusId, atSec);
  }

  async emitEvent(
    focusId: string,
    eventType: string,
    text: string,
    payload: Record<string, unknown>,
    dedupeWindowSec?: number
  ): Promise<void> {
    const eventHash = shortHash({ eventType, text, payload });

    const inserted = this.repo.appendEvent({
      focusId,
      eventType,
      eventHash,
      payloadJson: JSON.stringify(payload),
      dedupeWindowSec
    });

    if (!inserted) return;

    await this.notifier.notify({
      focusId,
      eventType,
      text,
      payload
    });
  }

  async emitMonitoringHeartbeat(task: FocusTask): Promise<void> {
    const last = this.repo.getLastEventByType(task.id, 'monitoring_heartbeat');
    if (last && nowSec() - last.createdAt < 600) return;

    await this.emitEvent(
      task.id,
      'monitoring_heartbeat',
      `👀 Monitorizando ${task.playerName}. Estado: ${task.status}.`,
      {
        focus_id: task.id,
        player_id: task.playerId,
        status: task.status
      }
    );
  }

  private findTask(input: { focusId?: string; playerQuery?: string }): FocusTask {
    if (input.focusId) {
      const task = this.repo.getTaskById(input.focusId);
      if (!task) throw new FocusError('FOCUS_NOT_FOUND', `No existe focus_id=${input.focusId}`);
      return task;
    }

    if (input.playerQuery) {
      const task = this.repo.getTaskByPlayerQuery(input.playerQuery.trim());
      if (!task) {
        throw new FocusError('FOCUS_NOT_FOUND', `No se encontró foco para query=${input.playerQuery}`);
      }
      return task;
    }

    throw new FocusError('VALIDATION_ERROR', 'Debes indicar focus_id o player_query.');
  }

  private requirePositiveInt(value: number, field: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new FocusError('VALIDATION_ERROR', `${field} debe ser entero positivo.`);
    }
    return parsed;
  }

  private pickBestMatch(
    query: string,
    matches: Array<{ id: number; name: string; teamName: string | null }>
  ): { id: number; name: string; teamName: string | null } {
    const normalizedQuery = this.normalize(query);

    const exact = matches.find((entry) => this.normalize(entry.name) === normalizedQuery);
    if (exact) return exact;

    const startsWith = matches.find((entry) => this.normalize(entry.name).startsWith(normalizedQuery));
    if (startsWith) return startsWith;

    return matches[0];
  }

  private normalize(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }
}
