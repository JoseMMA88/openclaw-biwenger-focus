import type { AuctionSnapshot } from '../domain/focus.js';
import type { DailyMarketSnapshot } from '../domain/market.js';
import { Logger } from '../logger.js';
import { McpBiwengerClient } from '../mcp/McpBiwengerClient.js';
import { asArray, asRecord, getByPath, pickFirstNumber, pickFirstPositiveInt, pickFirstString } from '../utils/types.js';

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
      include_player_details: true,
      competition_candidates: competitionCandidates
    });

    const auctionsRaw = asArray(payload.auctions);

    const auctions = auctionsRaw
      .map((entry) => this.mapAuction(asRecord(entry)))
      .filter((entry): entry is AuctionSnapshot => entry !== null);

    const unresolved = auctions.filter((entry) => this.isMissingPlayerName(entry.playerName));
    if (unresolved.length > 0) {
      const snapshotPayload = await this.mcp.callTool('biwenger_market_get_snapshot', {
        include_auctions: true,
        include_player_details: true,
        include_raw: true,
        competition_candidates: competitionCandidates
      });

      const playerNameIndex = this.collectPlayerNameIndex(snapshotPayload);
      for (const auction of unresolved) {
        const resolved = playerNameIndex.get(auction.playerId);
        if (resolved && !this.isMissingPlayerName(resolved)) {
          auction.playerName = resolved;
        }
      }
    }

    return auctions;
  }

  async getDailyMarket(competitionCandidates: string[] = []): Promise<DailyMarketSnapshot[]> {
    const payload = await this.mcp.callTool('biwenger_market_get_snapshot', {
      include_auctions: true,
      include_player_details: true,
      include_raw: true,
      competition_candidates: competitionCandidates
    });

    const arrays = this.extractDailyMarketArrays(payload);
    const seen = new Set<number>();
    const items: DailyMarketSnapshot[] = [];

    for (const list of arrays) {
      for (const entry of list) {
        const parsed = this.mapDailyMarketPlayer(asRecord(entry));
        if (!parsed) continue;
        if (seen.has(parsed.playerId)) continue;
        seen.add(parsed.playerId);
        items.push(parsed);
      }
    }

    return items;
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

  async getPlayerDisplayName(playerId: number, competition?: string): Promise<string | null> {
    const payload = await this.mcp.callTool('biwenger_player_get_details', {
      player_id: playerId,
      competition
    });

    const data = asRecord(payload.data);
    const player = asRecord(data.player);
    const source = {
      ...payload,
      data,
      player
    };

    return pickFirstString(source, [
      'player.name',
      'player.shortName',
      'player.displayName',
      'player.nickname',
      'player.fullName',
      'name'
    ]);
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
      [
        'player.name',
        'player.shortName',
        'player.displayName',
        'player.nickname',
        'player.fullName',
        'playerName',
        'player_name',
        'player.playerName',
        'name',
        'requestedPlayer.name',
        'requestedPlayers.0.name'
      ]
    );

    const currentPrice = pickFirstNumber(source, [
      'amount',
      'price',
      'current_price',
      'currentPrice',
      'startingPrice',
      'startPrice',
      'initialPrice',
      'initial_price',
      'marketPrice',
      'market_value',
      'bid.amount',
      'bidAmount',
      'bid_amount',
      'offer.amount',
      'highestBid.amount',
      'highest_bid.amount',
      'currentBid.amount',
      'current_bid.amount'
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

  private collectPlayerNameIndex(payload: Record<string, unknown>): Map<number, string> {
    const index = new Map<number, string>();

    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const entry of node) visit(entry);
        return;
      }

      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;

      const id = pickFirstPositiveInt(record, ['id', 'player_id', 'playerID', 'player.id']);
      const name = pickFirstString(record, ['name', 'player_name', 'playerName', 'shortName', 'displayName']);
      if (id && name && !this.isMissingPlayerName(name)) {
        index.set(id, name);
      }

      for (const value of Object.values(record)) {
        visit(value);
      }
    };

    visit(payload);
    return index;
  }

  private isMissingPlayerName(playerName: string | null): boolean {
    if (!playerName) return true;
    const normalized = playerName.trim();
    if (normalized.length === 0) return true;
    return /^Player\\s+\\d+$/i.test(normalized);
  }

  private extractDailyMarketArrays(payload: Record<string, unknown>): Array<Array<Record<string, unknown>>> {
    const paths = [
      'market',
      'players',
      'marketPlayers',
      'data.market',
      'data.players',
      'raw.market',
      'raw.players',
      'raw.data.market',
      'raw.data.players',
      'snapshot.market',
      'snapshot.players'
    ];

    const arrays: Array<Array<Record<string, unknown>>> = [];
    for (const path of paths) {
      const node = getByPath(payload, path);
      const list = asArray(node).map((entry) => asRecord(entry)).filter((entry) => Object.keys(entry).length > 0);
      if (list.length > 0) arrays.push(list);
    }

    return arrays;
  }

  private mapDailyMarketPlayer(source: Record<string, unknown>): DailyMarketSnapshot | null {
    const playerNode = asRecord(source.player);

    const playerId = pickFirstPositiveInt(
      { ...source, player: playerNode },
      ['player.id', 'playerID', 'player_id', 'requestedPlayers.0', 'id']
    );
    if (!playerId) return null;

    // Exclude auction-like entries from daily market stream.
    const maybeUntil = pickFirstNumber(source, ['until', 'end', 'endAt', 'expiresAt']);
    if (maybeUntil !== null && maybeUntil > 0) return null;

    const playerName = pickFirstString(
      { ...source, player: playerNode },
      [
        'player.name',
        'player.shortName',
        'player.displayName',
        'player.nickname',
        'player.fullName',
        'playerName',
        'player_name',
        'name'
      ]
    ) ?? `Player ${playerId}`;

    const currentPrice = pickFirstNumber(source, [
      'price',
      'amount',
      'value',
      'currentPrice',
      'current_price',
      'startingPrice',
      'startPrice',
      'initialPrice',
      'initial_price',
      'marketPrice',
      'market_value'
    ]);

    const previousPrice = pickFirstNumber(source, [
      'previousPrice',
      'prevPrice',
      'lastPrice',
      'last_price',
      'oldPrice',
      'old_price',
      'priceBefore'
    ]);

    return {
      playerId,
      playerName,
      currentPrice,
      previousPrice,
      raw: source
    };
  }
}
