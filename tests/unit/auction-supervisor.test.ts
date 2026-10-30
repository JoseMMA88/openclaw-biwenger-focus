import { describe, expect, it, vi } from 'vitest';
import { superviseCycle } from '../../src/auctions/AuctionSupervisor.js';

const credentials = { email: 'admin@example.com', password: 'secret', leagueId: 12 };
function setup(at: string) {
  return {
    credentials,
    now: vi.fn(() => new Date(at)),
    hasSuccessfulRun: vi.fn().mockResolvedValue(true),
    service: {
      setState: vi.fn().mockResolvedValue({ enabled: true, changed: true }),
      inspect: vi.fn().mockResolvedValue({ enabled: true, freePlayers: 15 })
    }
  };
}

describe('Auction supervisor', () => {
  it('repairs drift before the cycle and verifies it again', async () => {
    const options = setup('2026-10-30T04:37:00Z');
    expect(await superviseCycle(options)).toMatchObject({ repaired: true, problems: [] });
    expect(options.service.setState).toHaveBeenCalledWith({ ...credentials, enabled: true, writeDeadline: new Date('2026-10-30T06:00:00Z') });
    expect(options.service.inspect).toHaveBeenCalledWith(credentials, false);
  });
  it('reports an absent primary execution even when repair succeeds', async () => {
    const options = setup('2026-10-30T04:37:00Z');
    options.hasSuccessfulRun.mockResolvedValue(false);
    expect((await superviseCycle(options))?.problems.join()).toContain('No consta');
  });
  it('does not misreport the primary as missing during the initial grace period', async () => {
    const options = setup('2026-10-29T22:37:00Z');
    options.hasSuccessfulRun.mockResolvedValue(false);
    expect((await superviseCycle(options))?.problems).toEqual([]);
    expect(options.hasSuccessfulRun).not.toHaveBeenCalled();
  });
  it('only inspects after the cycle and reports missing generated auctions', async () => {
    const options = setup('2026-10-30T07:37:00Z');
    options.service.inspect.mockResolvedValue({ enabled: true, freePlayers: 15, market: { data: { auctions: [] } } });
    expect((await superviseCycle(options))?.problems.join()).toContain('No free-player');
    expect(options.service.setState).not.toHaveBeenCalled();
  });
  it('prevents repair if the deadline passes while preparing a preflight run', async () => {
    const options = setup('2026-10-30T05:59:59Z');
    options.now.mockReturnValueOnce(new Date('2026-10-30T05:59:59Z')).mockReturnValue(new Date('2026-10-30T06:00:00Z'));
    await expect(superviseCycle(options)).rejects.toThrow('deadline');
    expect(options.service.setState).not.toHaveBeenCalled();
  });
  it('does not touch league settings outside a cycle window', async () => {
    const options = setup('2026-10-31T04:37:00Z');
    expect(await superviseCycle(options)).toBeNull();
    expect(options.service.inspect).not.toHaveBeenCalled();
    expect(options.service.setState).not.toHaveBeenCalled();
  });
});
