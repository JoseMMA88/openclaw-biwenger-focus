import { describe, expect, it } from 'vitest';
import { auctionWindow, scheduledAction } from '../../src/auctions/AuctionSchedule.js';

describe('Madrid auction safety windows', () => {
  it.each([
    ['2026-10-29T22:07:00Z', 'open', 'preflight', '2026-10-30T06:00:00.000Z'],
    ['2026-07-23T21:07:00Z', 'open', 'preflight', '2026-07-24T05:00:00.000Z'],
    ['2026-10-25T19:07:00Z', 'close', 'preflight', '2026-10-26T06:00:00.000Z'],
    ['2026-03-29T18:07:00Z', 'close', 'preflight', '2026-03-30T05:00:00.000Z'],
    ['2026-10-30T06:00:00Z', 'open', 'postcycle', '2026-10-30T06:00:00.000Z']
  ])('classifies %s correctly', (at, action, phase, cycle) => {
    expect(auctionWindow(new Date(at))).toMatchObject({ action, phase, cycle: new Date(cycle) });
  });

  it('does not write after the deadline even for a delayed Thursday event', () => {
    expect(() => scheduledAction('7 23 * * 4', new Date('2026-10-30T07:20:00Z')))
      .toThrow('outside its pre-cycle window');
  });

  it('keeps delayed runs working before the deadline', () => {
    expect(scheduledAction('7 23 * * 4', new Date('2026-10-30T00:44:45Z'))).toBe('open');
  });

  it('rejects opening on an unrelated day', () => {
    expect(auctionWindow(new Date('2026-10-31T04:00:00Z'))).toBeNull();
    expect(() => scheduledAction('7 23 * * 4', new Date('2026-10-31T04:00:00Z'))).toThrow();
  });
});
