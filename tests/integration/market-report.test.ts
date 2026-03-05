import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MarketRepository } from '../../src/db/MarketRepository.js';
import { SqliteStore } from '../../src/db/SqliteStore.js';
import type { AuctionSnapshot } from '../../src/domain/focus.js';
import type { DailyMarketSnapshot } from '../../src/domain/market.js';
import { Logger } from '../../src/logger.js';
import { MarketReportService } from '../../src/market/MarketReportService.js';
import type { FocusNotification, Notifier } from '../../src/notify/Notifier.js';

class CaptureNotifier implements Notifier {
  readonly messages: FocusNotification[] = [];

  async notify(event: FocusNotification): Promise<void> {
    this.messages.push(event);
  }
}

describe('MarketReportService integration', () => {
  it('emits one daily report and stores report state', async () => {
    const dir = join(tmpdir(), `biwenger-market-report-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'market.db');

    const store = new SqliteStore(dbPath);
    await store.init();

    const repo = new MarketRepository(store);
    const notifier = new CaptureNotifier();
    const service = new MarketReportService({
      repo,
      notifier,
      logger: new Logger('error'),
      tz: 'Europe/Madrid',
      scheduleHour: 0,
      scheduleMinute: 0,
      topLimit: 10
    });

    const auctions: AuctionSnapshot[] = [
      {
        playerId: 32629,
        playerName: 'Marc Casado',
        currentPrice: 1_100_000,
        until: 1_900_000_000,
        highestBidderUserId: 222,
        raw: {}
      },
      {
        playerId: 19244,
        playerName: 'Hansi Flick',
        currentPrice: 12_000_000,
        until: 1_900_000_500,
        highestBidderUserId: 333,
        raw: {}
      }
    ];

    const daily: DailyMarketSnapshot[] = [
      {
        playerId: 38365,
        playerName: 'Mateo Joseph',
        currentPrice: 810_000,
        previousPrice: 760_000,
        raw: {}
      },
      {
        playerId: 40009,
        playerName: 'Luvumbo',
        currentPrice: 340_000,
        previousPrice: 330_000,
        raw: {}
      }
    ];

    service.observeMarket({ auctions, daily }, 1_770_000_000);

    const report1 = await service.emitDailyReport({ auctions, daily }, 1_770_000_010);
    expect(report1).not.toBeNull();
    expect(report1?.daily.activeCount).toBe(2);
    expect(report1?.auctions.activeCount).toBe(2);

    const report2 = await service.emitDailyReport({ auctions, daily }, 1_770_000_020);
    expect(report2).toBeNull();

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0].eventType).toBe('market_daily_report');

    const status = service.getStatus(1_770_000_030);
    expect(status.lastReportDate).not.toBeNull();

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
