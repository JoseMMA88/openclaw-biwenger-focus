import { randomUUID } from 'node:crypto';

import type { ClauseRuntime, ClauseStatus, ClauseTask } from '../domain/clause.js';
import { nowSec } from '../utils/time.js';
import { SqliteStore } from './SqliteStore.js';

interface ClauseTaskRow extends Record<string, unknown> {
  id: string;
  player_query: string;
  player_id: number;
  player_name: string;
  competition: string | null;
  max_clause_amount: number;
  scheduled_at: number;
  status: ClauseStatus;
  stop_reason: string | null;
  created_at: number;
  updated_at: number;
  executed_at: number | null;
  next_run_at: number;
  lock_token: string | null;
  lock_expires_at: number | null;
}

interface ClauseRuntimeRow extends Record<string, unknown> {
  clause_id: string;
  last_seen_clause_amount: number | null;
  last_seen_owner_user_id: number | null;
  executed_amount: number | null;
  consecutive_errors: number;
  last_error: string | null;
}

interface CreateClauseTaskInput {
  id: string;
  playerQuery: string;
  playerId: number;
  playerName: string;
  competition: string | null;
  maxClauseAmount: number;
  scheduledAt: number;
}

export class ClauseRepository {
  private readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  createTask(input: CreateClauseTaskInput): ClauseTask {
    const now = nowSec();

    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO clause_tasks (
          id, player_query, player_id, player_name, competition,
          max_clause_amount, scheduled_at, status, created_at, updated_at, next_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?);`,
        [
          input.id,
          input.playerQuery,
          input.playerId,
          input.playerName,
          input.competition,
          input.maxClauseAmount,
          input.scheduledAt,
          now,
          now,
          input.scheduledAt
        ]
      );

      this.store.run(
        `INSERT INTO clause_runtime (clause_id, consecutive_errors)
         VALUES (?, 0);`,
        [input.id]
      );
    });

    const created = this.getTaskById(input.id);
    if (!created) throw new Error('Failed to create clause task.');
    return created;
  }

  getTaskById(clauseId: string): ClauseTask | null {
    const row = this.store.get<ClauseTaskRow>('SELECT * FROM clause_tasks WHERE id = ?;', [clauseId]);
    return row ? this.mapTask(row) : null;
  }

  getTaskByPlayerQuery(playerQuery: string): ClauseTask | null {
    const row = this.store.get<ClauseTaskRow>(
      `SELECT * FROM clause_tasks
       WHERE lower(player_query) = lower(?)
       ORDER BY created_at DESC
       LIMIT 1;`,
      [playerQuery]
    );
    return row ? this.mapTask(row) : null;
  }

  getActiveTaskByPlayerId(playerId: number): ClauseTask | null {
    const row = this.store.get<ClauseTaskRow>(
      `SELECT * FROM clause_tasks
       WHERE player_id = ?
         AND status IN ('PENDING', 'EXECUTING')
       LIMIT 1;`,
      [playerId]
    );
    return row ? this.mapTask(row) : null;
  }

  listTasks(status?: ClauseStatus, limit = 50): ClauseTask[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));

    if (status) {
      return this.store
        .all<ClauseTaskRow>(
          'SELECT * FROM clause_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?;',
          [status, safeLimit]
        )
        .map((row) => this.mapTask(row));
    }

    return this.store
      .all<ClauseTaskRow>('SELECT * FROM clause_tasks ORDER BY created_at DESC LIMIT ?;', [safeLimit])
      .map((row) => this.mapTask(row));
  }

  updateTaskConfig(
    clauseId: string,
    patch: Partial<Pick<ClauseTask, 'maxClauseAmount' | 'scheduledAt'>>
  ): ClauseTask {
    const existing = this.getTaskById(clauseId);
    if (!existing) throw new Error(`Clause task not found: ${clauseId}`);

    const now = nowSec();
    this.store.run(
      `UPDATE clause_tasks
       SET max_clause_amount = ?,
           scheduled_at = ?,
           next_run_at = ?,
           updated_at = ?
       WHERE id = ?;`,
      [
        patch.maxClauseAmount ?? existing.maxClauseAmount,
        patch.scheduledAt ?? existing.scheduledAt,
        patch.scheduledAt ?? existing.nextRunAt,
        now,
        clauseId
      ]
    );

    const updated = this.getTaskById(clauseId);
    if (!updated) throw new Error(`Clause task not found after update: ${clauseId}`);
    return updated;
  }

  setTaskStatus(clauseId: string, status: ClauseStatus, stopReason: string | null = null): ClauseTask {
    const now = nowSec();
    const existing = this.getTaskById(clauseId);
    if (!existing) throw new Error(`Clause task not found: ${clauseId}`);

    const executedAt = ['COMPLETED_EXECUTED', 'COMPLETED_SKIPPED_MAX', 'CANCELLED', 'FAILED'].includes(status)
      ? now
      : null;

    this.store.run(
      `UPDATE clause_tasks
       SET status = ?,
           stop_reason = ?,
           executed_at = ?,
           updated_at = ?
       WHERE id = ?;`,
      [status, stopReason, executedAt, now, clauseId]
    );

    const updated = this.getTaskById(clauseId);
    if (!updated) throw new Error(`Clause task not found after status update: ${clauseId}`);
    return updated;
  }

  setNextRunAt(clauseId: string, nextRunAt: number): void {
    this.store.run(
      `UPDATE clause_tasks
       SET next_run_at = ?, updated_at = ?
       WHERE id = ?;`,
      [nextRunAt, nowSec(), clauseId]
    );
  }

  claimDueTasks(limit: number, lockTtlSec: number): ClauseTask[] {
    const now = nowSec();
    const safeLimit = Math.max(1, Math.min(limit, 20));
    const lockToken = randomUUID();
    const lockExpiresAt = now + lockTtlSec;

    this.store.run(
      `UPDATE clause_tasks
       SET lock_token = ?, lock_expires_at = ?, updated_at = ?
       WHERE id IN (
         SELECT id FROM clause_tasks
         WHERE status IN ('PENDING', 'EXECUTING')
           AND next_run_at <= ?
           AND (lock_expires_at IS NULL OR lock_expires_at < ?)
         ORDER BY next_run_at ASC
         LIMIT ?
       );`,
      [lockToken, lockExpiresAt, now, now, now, safeLimit]
    );

    return this.store
      .all<ClauseTaskRow>('SELECT * FROM clause_tasks WHERE lock_token = ?;', [lockToken])
      .map((row) => this.mapTask(row));
  }

  releaseLock(clauseId: string): void {
    this.store.run(
      `UPDATE clause_tasks
       SET lock_token = NULL,
           lock_expires_at = NULL,
           updated_at = ?
       WHERE id = ?;`,
      [nowSec(), clauseId]
    );
  }

  getRuntime(clauseId: string): ClauseRuntime {
    const row = this.store.get<ClauseRuntimeRow>('SELECT * FROM clause_runtime WHERE clause_id = ?;', [clauseId]);
    if (!row) {
      throw new Error(`Clause runtime not found for id: ${clauseId}`);
    }
    return this.mapRuntime(row);
  }

  patchRuntime(clauseId: string, patch: Partial<ClauseRuntime>): ClauseRuntime {
    const runtime = this.getRuntime(clauseId);
    const next: ClauseRuntime = {
      ...runtime,
      ...patch,
      clauseId
    };

    this.store.run(
      `UPDATE clause_runtime
       SET last_seen_clause_amount = ?,
           last_seen_owner_user_id = ?,
           executed_amount = ?,
           consecutive_errors = ?,
           last_error = ?
       WHERE clause_id = ?;`,
      [
        next.lastSeenClauseAmount,
        next.lastSeenOwnerUserId,
        next.executedAmount,
        next.consecutiveErrors,
        next.lastError,
        clauseId
      ]
    );

    return this.getRuntime(clauseId);
  }

  appendEvent(input: {
    clauseId: string;
    eventType: string;
    eventHash?: string;
    payloadJson: string;
    dedupeWindowSec?: number;
  }): boolean {
    if (input.eventHash && input.dedupeWindowSec) {
      const exists = this.store.get<{ id: number }>(
        `SELECT id
         FROM clause_events
         WHERE event_hash = ?
           AND created_at >= ?
         LIMIT 1;`,
        [input.eventHash, nowSec() - input.dedupeWindowSec]
      );
      if (exists) return false;
    }

    this.store.run(
      `INSERT INTO clause_events (clause_id, event_type, event_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?);`,
      [input.clauseId, input.eventType, input.eventHash ?? null, input.payloadJson, nowSec()]
    );

    return true;
  }

  private mapTask(row: ClauseTaskRow): ClauseTask {
    return {
      id: String(row.id),
      playerQuery: String(row.player_query),
      playerId: Number(row.player_id),
      playerName: String(row.player_name),
      competition: row.competition ? String(row.competition) : null,
      maxClauseAmount: Number(row.max_clause_amount),
      scheduledAt: Number(row.scheduled_at),
      status: String(row.status) as ClauseStatus,
      stopReason: row.stop_reason ? String(row.stop_reason) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      executedAt: row.executed_at === null ? null : Number(row.executed_at),
      nextRunAt: Number(row.next_run_at),
      lockToken: row.lock_token ? String(row.lock_token) : null,
      lockExpiresAt: row.lock_expires_at === null ? null : Number(row.lock_expires_at)
    };
  }

  private mapRuntime(row: ClauseRuntimeRow): ClauseRuntime {
    return {
      clauseId: String(row.clause_id),
      lastSeenClauseAmount: row.last_seen_clause_amount === null ? null : Number(row.last_seen_clause_amount),
      lastSeenOwnerUserId: row.last_seen_owner_user_id === null ? null : Number(row.last_seen_owner_user_id),
      executedAmount: row.executed_amount === null ? null : Number(row.executed_amount),
      consecutiveErrors: Number(row.consecutive_errors),
      lastError: row.last_error ? String(row.last_error) : null
    };
  }
}
