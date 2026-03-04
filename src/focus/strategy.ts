import type { AuctionSnapshot, FocusRuntime, FocusTask } from '../domain/focus.js';

export interface BidDecision {
  action:
    | 'MISSING_AUCTION'
    | 'MONITOR_ARMED'
    | 'MONITOR_BIDDING'
    | 'WAIT_COOLDOWN'
    | 'PLACE_BID'
    | 'MAX_REACHED';
  reason: string;
  remainingSec: number | null;
  targetBid: number | null;
}

interface DecideInput {
  nowSec: number;
  task: FocusTask;
  runtime: FocusRuntime;
  auction: AuctionSnapshot | null;
  isCurrentHighestBidder: boolean;
}

function nextBidAmount(currentPrice: number | null, runtime: FocusRuntime): number | null {
  if (currentPrice === null || currentPrice <= 0) return null;

  // Entry bid: use the minimum visible market price.
  if (runtime.lastBidAmount === null) {
    return currentPrice;
  }

  // If market price has not moved since our last bid, avoid duplicate bids.
  if (currentPrice <= runtime.lastBidAmount) {
    return null;
  }

  // Re-bids also use the minimum visible market price.
  return currentPrice;
}

export function decideBidAction(input: DecideInput): BidDecision {
  const { nowSec, task, runtime, auction, isCurrentHighestBidder } = input;

  if (!auction) {
    return {
      action: 'MISSING_AUCTION',
      reason: 'auction_not_found',
      remainingSec: null,
      targetBid: null
    };
  }

  const remainingSec = auction.until === null ? null : auction.until - nowSec;
  const currentPrice = auction.currentPrice ?? runtime.lastSeenPrice;
  const targetBid = nextBidAmount(currentPrice, runtime);

  if (remainingSec === null || remainingSec > task.startWhenRemainingSec) {
    return {
      action: 'MONITOR_ARMED',
      reason: 'outside_bidding_window',
      remainingSec,
      targetBid
    };
  }

  if (currentPrice === null || currentPrice <= 0) {
    return {
      action: 'MONITOR_BIDDING',
      reason: 'price_unavailable',
      remainingSec,
      targetBid: null
    };
  }
  if (targetBid === null) {
    return {
      action: 'MONITOR_BIDDING',
      reason: runtime.lastBidAmount === null ? 'price_unavailable' : 'no_higher_price_detected',
      remainingSec,
      targetBid: null
    };
  }

  if (targetBid > task.maxPrice) {
    return {
      action: 'MAX_REACHED',
      reason: 'max_reached',
      remainingSec,
      targetBid
    };
  }

  if (isCurrentHighestBidder) {
    return {
      action: 'MONITOR_BIDDING',
      reason: 'already_highest_bidder',
      remainingSec,
      targetBid
    };
  }

  if (runtime.lastBidAt !== null && nowSec - runtime.lastBidAt < task.cooldownSec) {
    return {
      action: 'WAIT_COOLDOWN',
      reason: 'cooldown_active',
      remainingSec,
      targetBid
    };
  }

  return {
    action: 'PLACE_BID',
    reason: 'within_window_and_under_limit',
    remainingSec,
    targetBid
  };
}
