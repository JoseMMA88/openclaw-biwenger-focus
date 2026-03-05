import type { AuctionSnapshot } from '../domain/focus.js';
import type { DailyMarketSnapshot, DailyMarketPlayerSnapshot, MarketPlayerSnapshot } from '../domain/market.js';
import { nowSec } from '../utils/time.js';
import { SqliteStore } from './SqliteStore.js';

interface MarketPlayerRow extends Record<string, unknown> {
  player_id: number;
  player_name: string;
  first_seen_at: number;
  first_seen_price: number | null;
  last_seen_at: number;
  last_seen_price: number | null;
  last_until: number | null;
  highest_bidder_user_id: number | null;
  was_active_at_last_report: number;
}

interface DailyMarketPlayerRow extends Record<string, unknown> {
  player_id: number;
  player_name: string;
  first_seen_at: number;
  first_seen_price: number | null;
  prev_seen_price: number | null;
  last_seen_at: number;
  last_seen_price: number | null;
  was_active_at_last_report: number;
}

export class MarketRepository {
  private readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  upsertAuctions(auctions: AuctionSnapshot[], atSec = nowSec()): void {
    this.store.transaction(() => {
      for (const auction of auctions) {
        const incomingName = this.normalizeName(auction.playerName, auction.playerId);
        const existing = this.store.get<MarketPlayerRow>(
          'SELECT * FROM market_players WHERE player_id = ?;',
          [auction.playerId]
        );

        if (!existing) {
          this.store.run(
            `INSERT INTO market_players (
              player_id, player_name, first_seen_at, first_seen_price,
              last_seen_at, last_seen_price, last_until, highest_bidder_user_id, was_active_at_last_report
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0);`,
            [
              auction.playerId,
              incomingName,
              atSec,
              auction.currentPrice,
              atSec,
              auction.currentPrice,
              auction.until,
              auction.highestBidderUserId
            ]
          );
          continue;
        }

        this.store.run(
          `UPDATE market_players
           SET player_name = ?,
               first_seen_price = ?,
               last_seen_at = ?,
               last_seen_price = ?,
               last_until = ?,
               highest_bidder_user_id = ?
           WHERE player_id = ?;`,
          [
            this.pickBestName(incomingName, String(existing.player_name)),
            existing.first_seen_price === null ? auction.currentPrice : existing.first_seen_price,
            atSec,
            auction.currentPrice,
            auction.until,
            auction.highestBidderUserId,
            auction.playerId
          ]
        );
      }
    });
  }

  upsertDailyMarket(players: DailyMarketSnapshot[], atSec = nowSec()): void {
    this.store.transaction(() => {
      for (const player of players) {
        const incomingName = this.normalizeName(player.playerName, player.playerId);
        const existing = this.store.get<DailyMarketPlayerRow>(
          'SELECT * FROM market_daily_players WHERE player_id = ?;',
          [player.playerId]
        );

        if (!existing) {
          this.store.run(
            `INSERT INTO market_daily_players (
              player_id, player_name, first_seen_at, first_seen_price,
              prev_seen_price, last_seen_at, last_seen_price, was_active_at_last_report
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0);`,
            [
              player.playerId,
              incomingName,
              atSec,
              player.currentPrice,
              null,
              atSec,
              player.currentPrice
            ]
          );
          continue;
        }

        this.store.run(
          `UPDATE market_daily_players
           SET player_name = ?,
               first_seen_price = ?,
               prev_seen_price = ?,
               last_seen_at = ?,
               last_seen_price = ?
           WHERE player_id = ?;`,
          [
            this.pickBestName(incomingName, String(existing.player_name)),
            existing.first_seen_price === null ? player.currentPrice : existing.first_seen_price,
            existing.last_seen_price,
            atSec,
            player.currentPrice,
            player.playerId
          ]
        );
      }
    });
  }

  hasReportForDate(reportDate: string): boolean {
    const row = this.store.get<{ report_date: string }>(
      'SELECT report_date FROM market_reports WHERE report_date = ? LIMIT 1;',
      [reportDate]
    );
    return row !== null;
  }

  recordReport(
    reportDate: string,
    payloadJson: string,
    activeAuctionPlayerIds: number[],
    activeDailyPlayerIds: number[],
    atSec = nowSec()
  ): void {
    this.store.transaction(() => {
      this.store.run(
        `INSERT INTO market_reports (report_date, created_at, payload_json)
         VALUES (?, ?, ?)
         ON CONFLICT(report_date) DO UPDATE SET
           created_at = excluded.created_at,
           payload_json = excluded.payload_json;`,
        [reportDate, atSec, payloadJson]
      );

      this.store.run('UPDATE market_players SET was_active_at_last_report = 0;');
      this.store.run('UPDATE market_daily_players SET was_active_at_last_report = 0;');

      if (activeAuctionPlayerIds.length > 0) {
        const placeholders = activeAuctionPlayerIds.map(() => '?').join(',');
        this.store.run(
          `UPDATE market_players
           SET was_active_at_last_report = 1
           WHERE player_id IN (${placeholders});`,
          activeAuctionPlayerIds
        );
      }

      if (activeDailyPlayerIds.length > 0) {
        const placeholders = activeDailyPlayerIds.map(() => '?').join(',');
        this.store.run(
          `UPDATE market_daily_players
           SET was_active_at_last_report = 1
           WHERE player_id IN (${placeholders});`,
          activeDailyPlayerIds
        );
      }
    });
  }

  getPlayersByIds(playerIds: number[]): MarketPlayerSnapshot[] {
    if (playerIds.length === 0) return [];

    const placeholders = playerIds.map(() => '?').join(',');
    return this.store
      .all<MarketPlayerRow>(
        `SELECT * FROM market_players
         WHERE player_id IN (${placeholders});`,
        playerIds
      )
      .map((row) => this.mapAuctionPlayer(row));
  }

  getDailyPlayersByIds(playerIds: number[]): DailyMarketPlayerSnapshot[] {
    if (playerIds.length === 0) return [];

    const placeholders = playerIds.map(() => '?').join(',');
    return this.store
      .all<DailyMarketPlayerRow>(
        `SELECT * FROM market_daily_players
         WHERE player_id IN (${placeholders});`,
        playerIds
      )
      .map((row) => this.mapDailyPlayer(row));
  }

  listPlayersSeenSince(minFirstSeenAt: number): MarketPlayerSnapshot[] {
    return this.store
      .all<MarketPlayerRow>(
        `SELECT * FROM market_players
         WHERE first_seen_at >= ?
         ORDER BY first_seen_at DESC
         LIMIT 1000;`,
        [minFirstSeenAt]
      )
      .map((row) => this.mapAuctionPlayer(row));
  }

  listDailyPlayersSeenSince(minFirstSeenAt: number): DailyMarketPlayerSnapshot[] {
    return this.store
      .all<DailyMarketPlayerRow>(
        `SELECT * FROM market_daily_players
         WHERE first_seen_at >= ?
         ORDER BY first_seen_at DESC
         LIMIT 1000;`,
        [minFirstSeenAt]
      )
      .map((row) => this.mapDailyPlayer(row));
  }

  listEndedSinceLastReport(activePlayerIds: number[], limit = 20): MarketPlayerSnapshot[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    if (activePlayerIds.length === 0) {
      return this.store
        .all<MarketPlayerRow>(
          `SELECT * FROM market_players
           WHERE was_active_at_last_report = 1
           ORDER BY last_seen_at DESC
           LIMIT ?;`,
          [safeLimit]
        )
        .map((row) => this.mapAuctionPlayer(row));
    }

    const placeholders = activePlayerIds.map(() => '?').join(',');
    return this.store
      .all<MarketPlayerRow>(
        `SELECT * FROM market_players
         WHERE was_active_at_last_report = 1
           AND player_id NOT IN (${placeholders})
         ORDER BY last_seen_at DESC
         LIMIT ?;`,
        [...activePlayerIds, safeLimit]
      )
      .map((row) => this.mapAuctionPlayer(row));
  }

  listDailyEndedSinceLastReport(activePlayerIds: number[], limit = 20): DailyMarketPlayerSnapshot[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    if (activePlayerIds.length === 0) {
      return this.store
        .all<DailyMarketPlayerRow>(
          `SELECT * FROM market_daily_players
           WHERE was_active_at_last_report = 1
           ORDER BY last_seen_at DESC
           LIMIT ?;`,
          [safeLimit]
        )
        .map((row) => this.mapDailyPlayer(row));
    }

    const placeholders = activePlayerIds.map(() => '?').join(',');
    return this.store
      .all<DailyMarketPlayerRow>(
        `SELECT * FROM market_daily_players
         WHERE was_active_at_last_report = 1
           AND player_id NOT IN (${placeholders})
         ORDER BY last_seen_at DESC
         LIMIT ?;`,
        [...activePlayerIds, safeLimit]
      )
      .map((row) => this.mapDailyPlayer(row));
  }

  getLastReport(): { reportDate: string; createdAt: number } | null {
    const row = this.store.get<{ report_date: string; created_at: number }>(
      `SELECT report_date, created_at
       FROM market_reports
       ORDER BY created_at DESC
       LIMIT 1;`
    );

    if (!row) return null;
    return {
      reportDate: String(row.report_date),
      createdAt: Number(row.created_at)
    };
  }

  private mapAuctionPlayer(row: MarketPlayerRow): MarketPlayerSnapshot {
    return {
      playerId: Number(row.player_id),
      playerName: String(row.player_name),
      firstSeenAt: Number(row.first_seen_at),
      firstSeenPrice: row.first_seen_price === null ? null : Number(row.first_seen_price),
      lastSeenAt: Number(row.last_seen_at),
      lastSeenPrice: row.last_seen_price === null ? null : Number(row.last_seen_price),
      lastUntil: row.last_until === null ? null : Number(row.last_until),
      highestBidderUserId: row.highest_bidder_user_id === null ? null : Number(row.highest_bidder_user_id),
      wasActiveAtLastReport: Number(row.was_active_at_last_report) === 1
    };
  }

  private mapDailyPlayer(row: DailyMarketPlayerRow): DailyMarketPlayerSnapshot {
    return {
      playerId: Number(row.player_id),
      playerName: String(row.player_name),
      firstSeenAt: Number(row.first_seen_at),
      firstSeenPrice: row.first_seen_price === null ? null : Number(row.first_seen_price),
      prevSeenPrice: row.prev_seen_price === null ? null : Number(row.prev_seen_price),
      lastSeenAt: Number(row.last_seen_at),
      lastSeenPrice: row.last_seen_price === null ? null : Number(row.last_seen_price),
      wasActiveAtLastReport: Number(row.was_active_at_last_report) === 1
    };
  }

  private pickBestName(incoming: string, current: string): string {
    const incomingIsFallback = this.isFallbackName(incoming);
    const currentIsFallback = this.isFallbackName(current);

    if (!incomingIsFallback) return incoming;
    if (!currentIsFallback) return current;
    return incoming;
  }

  private normalizeName(name: string | null, playerId: number): string {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length === 0) return `Player ${playerId}`;
    return trimmed;
  }

  private isFallbackName(name: string): boolean {
    return /^Player\s+\d+$/i.test(name.trim());
  }
}
