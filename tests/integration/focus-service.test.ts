import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { FocusRepository } from '../../src/db/FocusRepository.js';
import { SqliteStore } from '../../src/db/SqliteStore.js';
import { FocusError, FocusService } from '../../src/focus/FocusService.js';
import { Logger } from '../../src/logger.js';
import type { FocusNotification, Notifier } from '../../src/notify/Notifier.js';

class FakeGateway {
  async searchPlayerByName(): Promise<Array<{ id: number; name: string; teamName: string | null }>> {
    return [{ id: 10, name: 'Kylian Mbappe', teamName: 'Real Madrid' }];
  }

  async getAuctions(): Promise<Array<{ playerId: number; playerName: string; currentPrice: number; until: number; highestBidderUserId: number; raw: Record<string, unknown> }>> {
    return [{
      playerId: 10,
      playerName: 'Kylian Mbappe',
      currentPrice: 400000,
      until: 1800000000,
      highestBidderUserId: 1,
      raw: {}
    }];
  }
}

class CaptureNotifier implements Notifier {
  readonly messages: FocusNotification[] = [];

  async notify(event: FocusNotification): Promise<void> {
    this.messages.push(event);
  }
}

describe('FocusService integration', () => {
  it('creates, updates and cancels focus with SQLite persistence', async () => {
    const dir = join(tmpdir(), `biwenger-focus-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'focus.db');

    const store = new SqliteStore(dbPath);
    await store.init();

    const repo = new FocusRepository(store);
    const notifier = new CaptureNotifier();
    const service = new FocusService({
      repo,
      gateway: new FakeGateway() as never,
      notifier,
      logger: new Logger('error'),
      defaults: {
        startWhenRemainingSec: 3600,
        bidStep: 50000,
        pollSec: 20,
        cooldownSec: 75
      }
    });

    const created = await service.createFocus({
      playerQuery: 'mbappe',
      maxPrice: 900000
    });

    expect(created.playerId).toBe(10);

    await expect(service.createFocus({
      playerQuery: 'mbappe',
      maxPrice: 900000
    })).rejects.toMatchObject({ code: 'FOCUS_CONFLICT' } satisfies Partial<FocusError>);

    const updated = service.updateFocus({
      focusId: created.focusId,
      bidStep: 60000
    });

    expect(updated.bidStep).toBe(60000);

    const cancelled = await service.cancelFocus(created.focusId);
    expect(cancelled.status).toBe('CANCELLED');

    expect(notifier.messages.length).toBeGreaterThanOrEqual(2);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
