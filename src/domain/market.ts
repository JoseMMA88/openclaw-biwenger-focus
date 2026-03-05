export interface MarketPlayerSnapshot {
  playerId: number;
  playerName: string;
  firstSeenAt: number;
  firstSeenPrice: number | null;
  lastSeenAt: number;
  lastSeenPrice: number | null;
  lastUntil: number | null;
  highestBidderUserId: number | null;
  wasActiveAtLastReport: boolean;
}

export interface MarketDailySummary {
  reportDate: string;
  nowSec: number;
  activeCount: number;
  newTodayCount: number;
  newTodayTop: Array<{
    playerId: number;
    playerName: string;
    firstSeenPrice: number | null;
    price: number | null;
    deltaFromFirstSeen: number | null;
    until: number | null;
  }>;
  topRisers: Array<{
    playerId: number;
    playerName: string;
    fromPrice: number;
    toPrice: number;
    rise: number;
  }>;
  endedSinceLastReport: Array<{
    playerId: number;
    playerName: string;
    lastSeenPrice: number | null;
    lastSeenAt: number;
  }>;
}
