import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClauseRepository } from '../../src/db/ClauseRepository.js';
import { SqliteStore } from '../../src/db/SqliteStore.js';
import { ClauseError, ClauseService } from '../../src/clause/ClauseService.js';
import { Logger } from '../../src/logger.js';
import type { FocusNotification, Notifier } from '../../src/notify/Notifier.js';
import { nowSec } from '../../src/utils/time.js';

class FakeGateway {
  async searchPlayerByName(): Promise<Array<{ id: number; name: string; teamName: string | null }>> {
    return [{ id: 32629, name: 'Marc Casado', teamName: 'FC Barcelona' }];
  }
}

class CaptureNotifier implements Notifier {
  readonly messages: FocusNotification[] = [];

  async notify(event: FocusNotification): Promise<void> {
    this.messages.push(event);
  }
}

describe('ClauseService integration', () => {
  it('creates, updates and cancels a scheduled clause task with persistence', async () => {
    const dir = join(tmpdir(), `biwenger-clause-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'clause.db');

    const store = new SqliteStore(dbPath);
    await store.init();

    const repo = new ClauseRepository(store);
    const notifier = new CaptureNotifier();
    const service = new ClauseService({
      repo,
      gateway: new FakeGateway() as never,
      notifier,
      logger: new Logger('error')
    });

    const created = await service.createSchedule({
      playerQuery: 'casado',
      maxClauseAmount: 1_150_000,
      executeAt: nowSec() + 120
    });

    expect(created.playerId).toBe(32629);

    await expect(service.createSchedule({
      playerQuery: 'casado',
      maxClauseAmount: 1_150_000,
      executeAt: nowSec() + 240
    })).rejects.toMatchObject({ code: 'CLAUSE_CONFLICT' } satisfies Partial<ClauseError>);

    const updated = service.updateSchedule({
      clauseId: created.clauseId,
      maxClauseAmount: 1_200_000,
      executeAt: nowSec() + 300
    });

    expect(updated.maxClauseAmount).toBe(1_200_000);

    const cancelled = await service.cancelSchedule(created.clauseId);
    expect(cancelled.status).toBe('CANCELLED');

    expect(notifier.messages.length).toBeGreaterThanOrEqual(2);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
