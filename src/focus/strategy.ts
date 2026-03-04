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

  if (remainingSec === null || remainingSec > task.startWhenRemainingSec) {
    return {
      action: 'MONITOR_ARMED',
      reason: 'outside_bidding_window',
      remainingSec,
      targetBid: currentPrice === null ? null : currentPrice + task.bidStep
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

  const targetBid = currentPrice + task.bidStep;

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
