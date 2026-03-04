import { describe, expect, it } from 'vitest';

import type { FocusRuntime, FocusTask } from '../../src/domain/focus.js';
import { decideBidAction } from '../../src/focus/strategy.js';

function buildTask(overrides: Partial<FocusTask> = {}): FocusTask {
  return {
    id: 'focus-1',
    playerQuery: 'Mbappe',
    playerId: 10,
    playerName: 'Kylian Mbappe',
    competition: null,
    maxPrice: 1_000_000,
    startWhenRemainingSec: 3600,
    bidStep: 50_000,
    pollSec: 20,
    cooldownSec: 75,
    status: 'PENDING',
    stopReason: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    finishedAt: null,
    nextPollAt: 0,
    lockToken: null,
    lockExpiresAt: null,
    ...overrides
  };
}

function buildRuntime(overrides: Partial<FocusRuntime> = {}): FocusRuntime {
  return {
    focusId: 'focus-1',
    lastSeenPrice: 300_000,
    lastSeenUntil: 1_700_000_000,
    lastBidAmount: null,
    lastBidAt: null,
    missingSince: null,
    consecutiveErrors: 0,
    lastError: null,
    ownerUserId: null,
    isCurrentHighestBidder: null,
    myUserId: null,
    ...overrides
  };
}

describe('decideBidAction', () => {
  it('returns MONITOR_ARMED when still outside bidding window', () => {
    const now = 1_699_995_000;

    const result = decideBidAction({
      nowSec: now,
      task: buildTask(),
      runtime: buildRuntime(),
      auction: {
        playerId: 10,
        playerName: 'Mbappe',
        currentPrice: 400_000,
        until: now + 7200,
        highestBidderUserId: 123,
        raw: {}
      },
      isCurrentHighestBidder: false
    });

    expect(result.action).toBe('MONITOR_ARMED');
  });

  it('returns PLACE_BID when in window, below max and no cooldown', () => {
    const now = 1_699_995_000;

    const result = decideBidAction({
      nowSec: now,
      task: buildTask(),
      runtime: buildRuntime(),
      auction: {
        playerId: 10,
        playerName: 'Mbappe',
        currentPrice: 400_000,
        until: now + 300,
        highestBidderUserId: 123,
        raw: {}
      },
      isCurrentHighestBidder: false
    });

    expect(result.action).toBe('PLACE_BID');
    expect(result.targetBid).toBe(400_000);
  });

  it('returns MAX_REACHED when next bid exceeds max', () => {
    const now = 1_699_995_000;

    const result = decideBidAction({
      nowSec: now,
      task: buildTask({ maxPrice: 420_000 }),
      runtime: buildRuntime({ lastBidAmount: 390_000 }),
      auction: {
        playerId: 10,
        playerName: 'Mbappe',
        currentPrice: 400_000,
        until: now + 200,
        highestBidderUserId: 123,
        raw: {}
      },
      isCurrentHighestBidder: false
    });

    expect(result.action).toBe('MAX_REACHED');
  });

  it('uses bid_step after first bid has been placed', () => {
    const now = 1_699_995_000;

    const result = decideBidAction({
      nowSec: now,
      task: buildTask(),
      runtime: buildRuntime({ lastBidAmount: 400_000 }),
      auction: {
        playerId: 10,
        playerName: 'Mbappe',
        currentPrice: 410_000,
        until: now + 300,
        highestBidderUserId: 123,
        raw: {}
      },
      isCurrentHighestBidder: false
    });

    expect(result.action).toBe('PLACE_BID');
    expect(result.targetBid).toBe(460_000);
  });

  it('returns WAIT_COOLDOWN when cooldown is active', () => {
    const now = 1_699_995_000;

    const result = decideBidAction({
      nowSec: now,
      task: buildTask(),
      runtime: buildRuntime({ lastBidAt: now - 20 }),
      auction: {
        playerId: 10,
        playerName: 'Mbappe',
        currentPrice: 400_000,
        until: now + 200,
        highestBidderUserId: 123,
        raw: {}
      },
      isCurrentHighestBidder: false
    });

    expect(result.action).toBe('WAIT_COOLDOWN');
  });
});
