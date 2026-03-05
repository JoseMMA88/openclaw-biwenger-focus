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

export interface DailyMarketSnapshot {
  playerId: number;
  playerName: string;
  currentPrice: number | null;
  previousPrice: number | null;
  raw: Record<string, unknown>;
}

export interface DailyMarketPlayerSnapshot {
  playerId: number;
  playerName: string;
  firstSeenAt: number;
  firstSeenPrice: number | null;
  prevSeenPrice: number | null;
  lastSeenAt: number;
  lastSeenPrice: number | null;
  wasActiveAtLastReport: boolean;
}

export interface MarketDailySummary {
  reportDate: string;
  nowSec: number;
  auctions: {
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
  };
  daily: {
    activeCount: number;
    newTodayCount: number;
    newTodayTop: Array<{
      playerId: number;
      playerName: string;
      firstSeenPrice: number | null;
      price: number | null;
      deltaFromFirstSeen: number | null;
    }>;
    topRisers: Array<{
      playerId: number;
      playerName: string;
      fromPrice: number;
      toPrice: number;
      rise: number;
      risePct: number;
      lastDelta: number | null;
    }>;
    recommended: Array<{
      playerId: number;
      playerName: string;
      price: number;
      riseToday: number;
      riseTodayPct: number;
      riseLastTick: number | null;
      riseLastTickPct: number | null;
      score: number;
      reason: string;
    }>;
  };
}
