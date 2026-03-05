import type { AuctionSnapshot } from '../domain/focus.js';
import { Logger } from '../logger.js';
import { McpBiwengerClient } from '../mcp/McpBiwengerClient.js';
import { asArray, asRecord, pickFirstNumber, pickFirstPositiveInt, pickFirstString } from '../utils/types.js';

export interface PlayerMatch {
  id: number;
  name: string;
  teamName: string | null;
}

export interface UserRoster {
  userId: number | null;
  playerIds: number[];
}

export interface ClauseSnapshot {
  playerId: number;
  playerName: string | null;
  clauseAmount: number | null;
  ownerUserId: number | null;
  raw: Record<string, unknown>;
}

export class BiwengerGateway {
  private readonly mcp: McpBiwengerClient;
  private readonly logger: Logger;

  constructor(mcp: McpBiwengerClient, logger: Logger) {
    this.mcp = mcp;
    this.logger = logger;
  }

  async searchPlayerByName(name: string, competition?: string): Promise<PlayerMatch[]> {
    const payload = await this.mcp.callTool('biwenger_player_search_by_name', {
      name,
      competition,
      limit: 20
    });

    const matchesRaw = asArray(payload.matches);
    const matches: PlayerMatch[] = [];

    for (const entry of matchesRaw) {
      const node = asRecord(entry);
      const id = Number(node.id);
      const playerName = typeof node.name === 'string' ? node.name.trim() : '';
      if (!Number.isInteger(id) || id <= 0 || !playerName) continue;

      const teamName = typeof node.team_name === 'string' ? node.team_name.trim() || null : null;
      matches.push({ id, name: playerName, teamName });
    }

    return matches;
  }

  async getAuctions(competitionCandidates: string[] = []): Promise<AuctionSnapshot[]> {
    const payload = await this.mcp.callTool('biwenger_market_get_auctions', {
      include_player_details: false,
      competition_candidates: competitionCandidates
    });

    const auctionsRaw = asArray(payload.auctions);

    return auctionsRaw
      .map((entry) => this.mapAuction(asRecord(entry)))
      .filter((entry): entry is AuctionSnapshot => entry !== null);
  }

  async placeBid(playerId: number, amount: number): Promise<void> {
    const payload = await this.mcp.callTool('biwenger_offers_place_bid', {
      player_id: playerId,
      amount
    });

    if (payload.status !== 'bid_placed') {
      throw new Error('Unexpected MCP response while placing bid.');
    }
  }

  async getPlayerClauseInfo(playerId: number, competition?: string): Promise<ClauseSnapshot> {
    const payload = await this.mcp.callTool('biwenger_player_get_details', {
      player_id: playerId,
      competition
    });

    const data = asRecord(payload.data);
    const player = asRecord(data.player);
    const owner = asRecord(player.owner);
    const clause = asRecord(player.clause);
    const source = {
      ...payload,
      data,
      player,
      owner,
      clause
    };

    const resolvedPlayerId = pickFirstPositiveInt(source, ['player.id', 'id']) ?? playerId;
    const playerName = pickFirstString(source, ['player.name', 'player.shortName', 'name']);
    const clauseAmount = pickFirstNumber(source, [
      'player.clause',
      'player.clauseValue',
      'player.clause_amount',
      'player.releaseClause',
      'player.buyoutClause',
      'player.clausePrice',
      'clause.amount',
      'clause.value',
      'clause'
    ]);
    const ownerUserId = pickFirstPositiveInt(source, [
      'player.owner.id',
      'player.ownerID',
      'player.owner_user_id',
      'owner.id',
      'owner.user_id',
      'user.id',
      'userID'
    ]);

    return {
      playerId: resolvedPlayerId,
      playerName,
      clauseAmount,
      ownerUserId,
      raw: source
    };
  }

  async payClause(playerId: number, ownerUserId: number, amount: number): Promise<void> {
    const payload = await this.mcp.callTool('biwenger_offers_pay_clause', {
      player_id: String(playerId),
      owner_user_id: String(ownerUserId),
      amount: String(amount),
      auto_confirm: true
    });

    const status = pickFirstString(payload, ['status', 'result', 'message'])?.toLowerCase() ?? '';
    if (status.includes('error')) {
      throw new Error(`Unexpected MCP response while paying clause: ${status}`);
    }
  }

  async getMyUserRoster(): Promise<UserRoster> {
    const payload = await this.mcp.callTool('biwenger_user_get_me', {
      fields: 'id,players(id)'
    });

    const data = asRecord(payload.data);
    const userId = pickFirstPositiveInt(data, ['id']);
    const playersRaw = asArray(data.players);

    const playerIds = playersRaw
      .map((entry) => pickFirstPositiveInt(asRecord(entry), ['id']))
      .filter((id): id is number => id !== null);

    return {
      userId,
      playerIds
    };
  }

  async ping(): Promise<void> {
    const tools = await this.mcp.listTools();
    this.logger.debug('MCP tools loaded', {
      action: 'mcp_tools_loaded',
      count: tools.length
    });
  }

  private mapAuction(source: Record<string, unknown>): AuctionSnapshot | null {
    const playerNode = asRecord(source.player);

    const playerId = pickFirstPositiveInt(
      { ...source, player: playerNode },
      ['player.id', 'playerID', 'player_id', 'requestedPlayers.0', 'id']
    );

    if (!playerId) return null;

    const playerName = pickFirstString(
      { ...source, player: playerNode },
      ['player.name', 'player.shortName', 'player.displayName', 'name']
    );

    const currentPrice = pickFirstNumber(source, [
      'amount',
      'currentPrice',
      'bid.amount',
      'bidAmount',
      'offer.amount',
      'highestBid.amount',
      'currentBid.amount'
    ]);

    const untilRaw = pickFirstNumber(source, ['until', 'end', 'endAt', 'expiresAt']);
    const until = this.normalizeEpochSeconds(untilRaw);

    const highestBidderUserId = pickFirstPositiveInt(source, [
      'userID',
      'user.id',
      'bid.user_id',
      'highestBid.user_id',
      'currentBid.user_id'
    ]);

    return {
      playerId,
      playerName,
      currentPrice,
      until,
      highestBidderUserId,
      raw: source
    };
  }

  private normalizeEpochSeconds(value: number | null): number | null {
    if (!value || value <= 0) return null;

    if (value > 9_999_999_999) {
      return Math.floor(value / 1000);
    }

    return Math.floor(value);
  }
}
