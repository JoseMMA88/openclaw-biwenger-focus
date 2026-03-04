import { randomUUID } from 'node:crypto';

import { ACTIVE_STATUSES, type FocusRuntime, type FocusStatus, type FocusTask } from '../domain/focus.js';
import { nowSec } from '../utils/time.js';
import { SqliteStore } from './SqliteStore.js';

interface FocusTaskRow extends Record<string, unknown> {
  id: string;
  player_query: string;
  player_id: number;
  player_name: string;
  competition: string | null;
  max_price: number;
  start_when_remaining_sec: number;
  bid_step: number;
  poll_sec: number;
  cooldown_sec: number;
  status: FocusStatus;
  stop_reason: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  next_poll_at: number;
  lock_token: string | null;
  lock_expires_at: number | null;
}

interface FocusRuntimeRow extends Record<string, unknown> {
  focus_id: string;
  last_seen_price: number | null;
  last_seen_until: number | null;
  last_bid_amount: number | null;
  last_bid_at: number | null;
  missing_since: number | null;
  consecutive_errors: number;
  last_error: string | null;
  owner_user_id: number | null;
  is_current_highest_bidder: number | null;
  my_user_id: number | null;
}

interface CreateTaskInput {
  id: string;
  playerQuery: string;
  playerId: number;
  playerName: string;
  competition: string | null;
  maxPrice: number;
  startWhenRemainingSec: number;
  bidStep: number;
  pollSec: number;
  cooldownSec: number;
}

export class FocusRepository {
  private readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  createTask(input: CreateTaskInput): FocusTask {
    const now = nowSec();

    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO focus_tasks (
          id, player_query, player_id, player_name, competition,
          max_price, start_when_remaining_sec, bid_step, poll_sec, cooldown_sec,
          status, created_at, updated_at, next_poll_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?);`,
        [
          input.id,
          input.playerQuery,
          input.playerId,
          input.playerName,
          input.competition,
          input.maxPrice,
          input.startWhenRemainingSec,
          input.bidStep,
          input.pollSec,
          input.cooldownSec,
          now,
          now,
          now
        ]
      );

      this.store.run(
        `INSERT INTO focus_runtime (
          focus_id, consecutive_errors
        ) VALUES (?, 0);`,
        [input.id]
      );
    });

    const created = this.getTaskById(input.id);
    if (!created) {
      throw new Error('Failed to create focus task.');
    }

    return created;
  }

  getTaskById(focusId: string): FocusTask | null {
    const row = this.store.get<FocusTaskRow>('SELECT * FROM focus_tasks WHERE id = ?;', [focusId]);
    return row ? this.mapTask(row) : null;
  }

  getTaskByPlayerQuery(playerQuery: string): FocusTask | null {
    const row = this.store.get<FocusTaskRow>(
      `SELECT * FROM focus_tasks
       WHERE lower(player_query) = lower(?)
       ORDER BY created_at DESC
       LIMIT 1;`,
      [playerQuery]
    );
    return row ? this.mapTask(row) : null;
  }

  getActiveTaskByPlayerId(playerId: number): FocusTask | null {
    const row = this.store.get<FocusTaskRow>(
      `SELECT * FROM focus_tasks
       WHERE player_id = ?
         AND status IN ('PENDING', 'ARMED', 'BIDDING')
       LIMIT 1;`,
      [playerId]
    );

    return row ? this.mapTask(row) : null;
  }

  listTasks(status?: FocusStatus, limit = 50): FocusTask[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));

    if (status) {
      return this.store
        .all<FocusTaskRow>(
          'SELECT * FROM focus_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?;',
          [status, safeLimit]
        )
        .map((row) => this.mapTask(row));
    }

    return this.store
      .all<FocusTaskRow>('SELECT * FROM focus_tasks ORDER BY created_at DESC LIMIT ?;', [safeLimit])
      .map((row) => this.mapTask(row));
  }

  updateTaskConfig(
    focusId: string,
    patch: Partial<Pick<FocusTask, 'maxPrice' | 'startWhenRemainingSec' | 'bidStep' | 'pollSec' | 'cooldownSec'>>
  ): FocusTask {
    const existing = this.getTaskById(focusId);
    if (!existing) {
      throw new Error(`Focus not found: ${focusId}`);
    }

    const now = nowSec();
    this.store.run(
      `UPDATE focus_tasks
       SET max_price = ?,
           start_when_remaining_sec = ?,
           bid_step = ?,
           poll_sec = ?,
           cooldown_sec = ?,
           updated_at = ?
       WHERE id = ?;`,
      [
        patch.maxPrice ?? existing.maxPrice,
        patch.startWhenRemainingSec ?? existing.startWhenRemainingSec,
        patch.bidStep ?? existing.bidStep,
        patch.pollSec ?? existing.pollSec,
        patch.cooldownSec ?? existing.cooldownSec,
        now,
        focusId
      ]
    );

    const updated = this.getTaskById(focusId);
    if (!updated) {
      throw new Error(`Focus not found after update: ${focusId}`);
    }

    return updated;
  }

  setTaskStatus(focusId: string, status: FocusStatus, stopReason: string | null = null): FocusTask {
    const now = nowSec();
    const existing = this.getTaskById(focusId);
    if (!existing) throw new Error(`Focus not found: ${focusId}`);

    const startedAt = existing.startedAt ?? (status === 'ARMED' || status === 'BIDDING' ? now : null);
    const finishedAt = ['COMPLETED_WON', 'COMPLETED_LOST', 'CANCELLED', 'FAILED'].includes(status) ? now : null;

    this.store.run(
      `UPDATE focus_tasks
       SET status = ?,
           stop_reason = ?,
           started_at = ?,
           finished_at = ?,
           updated_at = ?
       WHERE id = ?;`,
      [status, stopReason, startedAt, finishedAt, now, focusId]
    );

    const updated = this.getTaskById(focusId);
    if (!updated) throw new Error(`Focus not found after status update: ${focusId}`);
    return updated;
  }

  setNextPollAt(focusId: string, nextPollAt: number): void {
    this.store.run(
      `UPDATE focus_tasks
       SET next_poll_at = ?, updated_at = ?
       WHERE id = ?;`,
      [nextPollAt, nowSec(), focusId]
    );
  }

  claimDueTasks(limit: number, lockTtlSec: number): FocusTask[] {
    const now = nowSec();
    const safeLimit = Math.max(1, Math.min(limit, 50));
    const lockToken = randomUUID();
    const lockExpiresAt = now + lockTtlSec;

    this.store.run(
      `UPDATE focus_tasks
       SET lock_token = ?, lock_expires_at = ?, updated_at = ?
       WHERE id IN (
         SELECT id FROM focus_tasks
         WHERE status IN ('PENDING', 'ARMED', 'BIDDING')
           AND next_poll_at <= ?
           AND (lock_expires_at IS NULL OR lock_expires_at < ?)
         ORDER BY next_poll_at ASC
         LIMIT ?
       );`,
      [lockToken, lockExpiresAt, now, now, now, safeLimit]
    );

    return this.store
      .all<FocusTaskRow>('SELECT * FROM focus_tasks WHERE lock_token = ?;', [lockToken])
      .map((row) => this.mapTask(row));
  }

  releaseLock(focusId: string): void {
    this.store.run(
      `UPDATE focus_tasks
       SET lock_token = NULL,
           lock_expires_at = NULL,
           updated_at = ?
       WHERE id = ?;`,
      [nowSec(), focusId]
    );
  }

  getRuntime(focusId: string): FocusRuntime {
    const row = this.store.get<FocusRuntimeRow>('SELECT * FROM focus_runtime WHERE focus_id = ?;', [focusId]);
    if (!row) {
      throw new Error(`Runtime not found for focus: ${focusId}`);
    }

    return this.mapRuntime(row);
  }

  patchRuntime(focusId: string, patch: Partial<FocusRuntime>): FocusRuntime {
    const runtime = this.getRuntime(focusId);

    const next: FocusRuntime = {
      ...runtime,
      ...patch,
      focusId
    };

    this.store.run(
      `UPDATE focus_runtime
       SET last_seen_price = ?,
           last_seen_until = ?,
           last_bid_amount = ?,
           last_bid_at = ?,
           missing_since = ?,
           consecutive_errors = ?,
           last_error = ?,
           owner_user_id = ?,
           is_current_highest_bidder = ?,
           my_user_id = ?
       WHERE focus_id = ?;`,
      [
        next.lastSeenPrice,
        next.lastSeenUntil,
        next.lastBidAmount,
        next.lastBidAt,
        next.missingSince,
        next.consecutiveErrors,
        next.lastError,
        next.ownerUserId,
        next.isCurrentHighestBidder === null ? null : next.isCurrentHighestBidder ? 1 : 0,
        next.myUserId,
        focusId
      ]
    );

    return this.getRuntime(focusId);
  }

  appendEvent(input: {
    focusId: string;
    eventType: string;
    eventHash?: string;
    payloadJson: string;
    dedupeWindowSec?: number;
  }): boolean {
    if (input.eventHash && input.dedupeWindowSec) {
      const exists = this.store.get<{ id: number }>(
        `SELECT id
         FROM focus_events
         WHERE event_hash = ?
           AND created_at >= ?
         LIMIT 1;`,
        [input.eventHash, nowSec() - input.dedupeWindowSec]
      );

      if (exists) return false;
    }

    this.store.run(
      `INSERT INTO focus_events (focus_id, event_type, event_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?);`,
      [input.focusId, input.eventType, input.eventHash ?? null, input.payloadJson, nowSec()]
    );

    return true;
  }

  getLastEventByType(focusId: string, eventType: string): { createdAt: number } | null {
    const row = this.store.get<{ created_at: number }>(
      `SELECT created_at
       FROM focus_events
       WHERE focus_id = ?
         AND event_type = ?
       ORDER BY created_at DESC
       LIMIT 1;`,
      [focusId, eventType]
    );

    if (!row) return null;
    return { createdAt: Number(row.created_at) };
  }

  private mapTask(row: FocusTaskRow): FocusTask {
    return {
      id: String(row.id),
      playerQuery: String(row.player_query),
      playerId: Number(row.player_id),
      playerName: String(row.player_name),
      competition: row.competition ? String(row.competition) : null,
      maxPrice: Number(row.max_price),
      startWhenRemainingSec: Number(row.start_when_remaining_sec),
      bidStep: Number(row.bid_step),
      pollSec: Number(row.poll_sec),
      cooldownSec: Number(row.cooldown_sec),
      status: String(row.status) as FocusStatus,
      stopReason: row.stop_reason ? String(row.stop_reason) : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      startedAt: row.started_at === null ? null : Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      nextPollAt: Number(row.next_poll_at),
      lockToken: row.lock_token ? String(row.lock_token) : null,
      lockExpiresAt: row.lock_expires_at === null ? null : Number(row.lock_expires_at)
    };
  }

  private mapRuntime(row: FocusRuntimeRow): FocusRuntime {
    return {
      focusId: String(row.focus_id),
      lastSeenPrice: row.last_seen_price === null ? null : Number(row.last_seen_price),
      lastSeenUntil: row.last_seen_until === null ? null : Number(row.last_seen_until),
      lastBidAmount: row.last_bid_amount === null ? null : Number(row.last_bid_amount),
      lastBidAt: row.last_bid_at === null ? null : Number(row.last_bid_at),
      missingSince: row.missing_since === null ? null : Number(row.missing_since),
      consecutiveErrors: Number(row.consecutive_errors),
      lastError: row.last_error ? String(row.last_error) : null,
      ownerUserId: row.owner_user_id === null ? null : Number(row.owner_user_id),
      isCurrentHighestBidder: row.is_current_highest_bidder === null
        ? null
        : Number(row.is_current_highest_bidder) === 1,
      myUserId: row.my_user_id === null ? null : Number(row.my_user_id)
    };
  }
}
