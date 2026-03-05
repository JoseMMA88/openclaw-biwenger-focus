import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClauseService } from '../../src/clause/ClauseService.js';
import { ClauseWorker } from '../../src/clause/ClauseWorker.js';
import { ClauseRepository } from '../../src/db/ClauseRepository.js';
import { SqliteStore } from '../../src/db/SqliteStore.js';
import type { ClauseSnapshot } from '../../src/gateway/BiwengerGateway.js';
import { Logger } from '../../src/logger.js';
import { CompositeNotifier } from '../../src/notify/CompositeNotifier.js';
import { LogNotifier } from '../../src/notify/LogNotifier.js';
import { nowSec } from '../../src/utils/time.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class FakeGateway {
  readonly paid: Array<{ playerId: number; ownerUserId: number; amount: number }> = [];
  private readonly clauseAmount: number;

  constructor(clauseAmount: number) {
    this.clauseAmount = clauseAmount;
  }

  async searchPlayerByName(): Promise<Array<{ id: number; name: string; teamName: string | null }>> {
    return [{ id: 32629, name: 'Marc Casado', teamName: 'FC Barcelona' }];
  }

  async getPlayerClauseInfo(playerId: number): Promise<ClauseSnapshot> {
    return {
      playerId,
      playerName: 'Marc Casado',
      clauseAmount: this.clauseAmount,
      ownerUserId: 777,
      raw: {}
    };
  }

  async payClause(playerId: number, ownerUserId: number, amount: number): Promise<void> {
    this.paid.push({ playerId, ownerUserId, amount });
  }
}

describe('ClauseWorker integration', () => {
  it('executes scheduled clause when current amount is under max', async () => {
    const dir = join(tmpdir(), `biwenger-clause-worker-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'worker.db');

    const store = new SqliteStore(dbPath);
    await store.init();

    const repo = new ClauseRepository(store);
    const gateway = new FakeGateway(1_120_000);
    const logger = new Logger('error');
    const notifier = new CompositeNotifier([new LogNotifier(logger)]);

    const service = new ClauseService({
      repo,
      gateway: gateway as never,
      notifier,
      logger
    });

    const created = await service.createSchedule({
      playerQuery: 'casado',
      maxClauseAmount: 1_150_000,
      executeAt: nowSec() + 1
    });

    const worker = new ClauseWorker({
      service,
      gateway: gateway as never,
      logger,
      lockTtlSec: 15,
      tickSec: 1,
      maxConsecutiveErrors: 5
    });

    worker.start();
    await sleep(2500);
    worker.stop();

    const status = service.getStatus({ clauseId: created.clauseId });
    expect(status.task.status).toBe('COMPLETED_EXECUTED');
    expect(status.runtime.executedAmount).toBe(1_120_000);
    expect(gateway.paid).toEqual([{ playerId: 32629, ownerUserId: 777, amount: 1_120_000 }]);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips scheduled clause when current amount exceeds max', async () => {
    const dir = join(tmpdir(), `biwenger-clause-worker-skip-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'worker-skip.db');

    const store = new SqliteStore(dbPath);
    await store.init();

    const repo = new ClauseRepository(store);
    const gateway = new FakeGateway(1_200_000);
    const logger = new Logger('error');
    const notifier = new CompositeNotifier([new LogNotifier(logger)]);

    const service = new ClauseService({
      repo,
      gateway: gateway as never,
      notifier,
      logger
    });

    const created = await service.createSchedule({
      playerQuery: 'casado',
      maxClauseAmount: 1_150_000,
      executeAt: nowSec() + 1
    });

    const worker = new ClauseWorker({
      service,
      gateway: gateway as never,
      logger,
      lockTtlSec: 15,
      tickSec: 1,
      maxConsecutiveErrors: 5
    });

    worker.start();
    await sleep(2500);
    worker.stop();

    const status = service.getStatus({ clauseId: created.clauseId });
    expect(status.task.status).toBe('COMPLETED_SKIPPED_MAX');
    expect(status.runtime.executedAmount).toBeNull();
    expect(gateway.paid).toEqual([]);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
