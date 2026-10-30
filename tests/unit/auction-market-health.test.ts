import { describe, expect, it } from 'vitest';
import { marketSummary, verifyMarket } from '../../src/auctions/AuctionMarketHealth.js';

const cycle = new Date('2026-10-30T06:00:00Z');
const now = new Date('2026-10-30T07:00:00Z');
const auction = { user: null, date: cycle.getTime() / 1000, until: now.getTime() / 1000 + 3600 };

describe('Post-cycle market verification', () => {
  it('confirms newly generated free players without requiring exactly 15 active', () => {
    const summary = marketSummary({ data: { auctions: [auction] } }, cycle, now);
    expect(summary).toEqual({ activeFree: 1, newFree: 1, undatedFree: 0 });
    expect(() => verifyMarket(summary, true)).not.toThrow();
  });
  it('does not mistake auctions sold by managers for generated free players', () => {
    const summary = marketSummary({ auctions: [{ ...auction, user: { id: 1 } }] }, cycle, now);
    expect(() => verifyMarket(summary, true)).toThrow('No free-player');
  });
  it('permits old auctions to finish after closing, but rejects new ones', () => {
    const old = { ...auction, date: cycle.getTime() / 1000 - 86400 };
    expect(() => verifyMarket(marketSummary({ auctions: [old] }, cycle, now), false)).not.toThrow();
    expect(() => verifyMarket(marketSummary({ auctions: [auction] }, cycle, now), false)).toThrow('New free-player');
  });
  it('does not hide unknown response shapes or missing timestamps', () => {
    expect(() => marketSummary({ data: {} }, cycle, now)).toThrow('no recognized');
    expect(() => verifyMarket(marketSummary({ auctions: [{ ...auction, date: null }] }, cycle, now), false))
      .toThrow('no creation date');
  });
  it('ignores expired auctions', () => {
    expect(marketSummary({ auctions: [{ ...auction, until: 1000 }] }, cycle, now).activeFree).toBe(0);
  });
});
