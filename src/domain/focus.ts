export const ACTIVE_STATUSES = ['PENDING', 'ARMED', 'BIDDING'] as const;
export const FINAL_STATUSES = ['COMPLETED_WON', 'COMPLETED_LOST', 'CANCELLED', 'FAILED'] as const;

export type FocusStatus = (typeof ACTIVE_STATUSES)[number] | (typeof FINAL_STATUSES)[number];

export interface FocusTask {
  id: string;
  playerQuery: string;
  playerId: number;
  playerName: string;
  competition: string | null;
  maxPrice: number;
  startWhenRemainingSec: number;
  bidStep: number;
  pollSec: number;
  cooldownSec: number;
  status: FocusStatus;
  stopReason: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  nextPollAt: number;
  lockToken: string | null;
  lockExpiresAt: number | null;
}

export interface FocusRuntime {
  focusId: string;
  lastSeenPrice: number | null;
  lastSeenUntil: number | null;
  lastBidAmount: number | null;
  lastBidAt: number | null;
  missingSince: number | null;
  consecutiveErrors: number;
  lastError: string | null;
  ownerUserId: number | null;
  isCurrentHighestBidder: boolean | null;
  myUserId: number | null;
}

export interface AuctionSnapshot {
  playerId: number;
  playerName: string | null;
  currentPrice: number | null;
  until: number | null;
  highestBidderUserId: number | null;
  raw: Record<string, unknown>;
}

export interface FocusDefaults {
  startWhenRemainingSec: number;
  bidStep: number;
  pollSec: number;
  cooldownSec: number;
}

export interface CreateFocusInput {
  playerQuery: string;
  maxPrice: number;
  startWhenRemainingSec?: number;
  bidStep?: number;
  pollSec?: number;
  cooldownSec?: number;
  competition?: string;
}

export interface UpdateFocusInput {
  focusId: string;
  maxPrice?: number;
  startWhenRemainingSec?: number;
  bidStep?: number;
  pollSec?: number;
  cooldownSec?: number;
}

export interface FocusStatusResult {
  task: FocusTask;
  runtime: FocusRuntime;
  remainingSec: number | null;
  nextBidAmount: number | null;
}
