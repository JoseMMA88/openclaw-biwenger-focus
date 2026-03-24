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

  async getDailyMarket(competitionCandidates: string[] = [], excludePlayerIds: number[] = []): Promise<DailyMarketSnapshot[]> {
    const excluded = new Set<number>(excludePlayerIds);
    const seen = new Set<number>();
    const items: DailyMarketSnapshot[] = [];

    try {
      const payload = await this.mcp.callTool('biwenger_market_get_daily_market', {
        include_player_details: true,
        include_raw: true,
        competition_candidates: competitionCandidates,
        exclude_player_ids: excludePlayerIds
      });

      const directDaily = asArray(payload.daily).map((entry) => asRecord(entry));
      for (const entry of directDaily) {
        if (!this.isDailyMarketFreeEntry(entry)) continue;
        const parsed = this.mapDailyMarketPlayer(entry);
        if (!parsed) continue;
        if (parsed.currentPrice === null) continue;
        if (excluded.has(parsed.playerId)) continue;
        if (seen.has(parsed.playerId)) continue;
        seen.add(parsed.playerId);
        items.push(parsed);
      }

      if (items.length > 0) {
        return items;
      }

      const arrays = this.extractDailyMarketArrays(payload);
      for (const list of arrays) {
        for (const entry of list) {
          const record = asRecord(entry);
          if (!this.isDailyMarketFreeEntry(record)) continue;
          const parsed = this.mapDailyMarketPlayer(record);
          if (!parsed) continue;
          if (parsed.currentPrice === null) continue;
          if (excluded.has(parsed.playerId)) continue;
          if (seen.has(parsed.playerId)) continue;
          seen.add(parsed.playerId);
          items.push(parsed);
        }
      }

      if (items.length === 0) {
        const inferred = this.inferDailyMarketPlayers(payload, excluded);
        for (const parsed of inferred) {
          if (!this.isDailyMarketFreeEntry(parsed.raw)) continue;
          if (parsed.currentPrice === null) continue;
          if (seen.has(parsed.playerId)) continue;
          seen.add(parsed.playerId);
          items.push(parsed);
        }
      }

      return items;
    } catch (error) {
      this.logger.warn('Daily market tool failed; falling back to market snapshot heuristics', {
        action: 'daily_market_tool_fallback',
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const payload = await this.mcp.callTool('biwenger_market_get_snapshot', {
      include_auctions: true,
      include_player_details: true,
      include_raw: true,
      competition_candidates: competitionCandidates
    });

    const fallbackArrays = this.extractDailyMarketArrays(payload);
    for (const list of fallbackArrays) {
      for (const entry of list) {
        const record = asRecord(entry);
        if (!this.isDailyMarketFreeEntry(record)) continue;
        const parsed = this.mapDailyMarketPlayer(record);
        if (!parsed) continue;
        if (parsed.currentPrice === null) continue;
        if (excluded.has(parsed.playerId)) continue;
        if (seen.has(parsed.playerId)) continue;
        seen.add(parsed.playerId);
        items.push(parsed);
      }
    }

    if (items.length === 0) {
      const inferred = this.inferDailyMarketPlayers(payload, excluded);
      for (const parsed of inferred) {
        if (!this.isDailyMarketFreeEntry(parsed.raw)) continue;
        if (parsed.currentPrice === null) continue;
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
    const details = asRecord(payload.details);
    const detailsRaw = asRecord(details.raw);
    const detailsPlayer = asRecord(details.player);
    const detailsRawPlayer = asRecord(detailsRaw.player);
    const detailsClause = asRecord(details.clause);
    const detailsOwner = asRecord(details.owner);
    const detailsRawClause = asRecord(detailsRaw.clause);
    const detailsRawOwner = asRecord(detailsRaw.owner);
    const source = {
      ...payload,
      data,
      player,
      detailsPlayer,
      detailsRawPlayer,
      owner,
      clause,
      details,
      detailsRaw,
      detailsClause,
      detailsOwner,
      detailsRawClause,
      detailsRawOwner
    };

    const resolvedPlayerId = pickFirstPositiveInt(source, [
      'player.id',
      'details.player.id',
      'detailsRaw.player.id',
      'id',
      'details.player_id',
      'details.id',
      'detailsRaw.id',
      'detailsRaw.player_id'
    ]) ?? playerId;
    const playerName = pickFirstString(source, [
      'player.name',
      'player.shortName',
      'details.player.name',
      'details.player.shortName',
      'detailsRaw.player.name',
      'detailsRaw.player.shortName',
      'name',
      'details.name',
      'details.shortName',
      'details.displayName',
      'details.fullName',
      'detailsRaw.name',
      'detailsRaw.shortName',
      'detailsRaw.displayName',
      'detailsRaw.fullName'
    ]);
    const clauseAmount = pickFirstNumber(source, [
      'player.clause',
      'player.clauseValue',
      'player.clause_amount',
      'player.releaseClause',
      'player.buyoutClause',
      'player.clausePrice',
      'details.player.clause',
      'details.player.clauseValue',
      'details.player.clause_amount',
      'details.player.releaseClause',
      'details.player.buyoutClause',
      'details.player.clausePrice',
      'detailsRaw.player.clause',
      'detailsRaw.player.clauseValue',
      'detailsRaw.player.clause_amount',
      'detailsRaw.player.releaseClause',
      'detailsRaw.player.buyoutClause',
      'detailsRaw.player.clausePrice',
      'details.clause',
      'details.clauseValue',
      'details.clause_amount',
      'details.releaseClause',
      'details.buyoutClause',
      'details.clausePrice',
      'detailsRaw.clause',
      'detailsRaw.clauseValue',
      'detailsRaw.clause_amount',
      'detailsRaw.releaseClause',
      'detailsRaw.buyoutClause',
      'detailsRaw.clausePrice',
      'detailsClause.amount',
      'detailsClause.value',
      'detailsRawClause.amount',
      'detailsRawClause.value',
      'clause.amount',
      'clause.value',
      'clause'
    ]);
    const ownerUserId = pickFirstPositiveInt(source, [
      'player.owner.id',
      'player.ownerID',
      'player.owner_user_id',
      'details.player.owner.id',
      'details.player.ownerID',
      'details.player.owner_user_id',
      'detailsRaw.player.owner.id',
      'detailsRaw.player.ownerID',
      'detailsRaw.player.owner_user_id',
      'details.owner.id',
      'details.ownerID',
      'details.owner_user_id',
      'detailsRaw.owner.id',
      'detailsRaw.ownerID',
      'detailsRaw.owner_user_id',
      'detailsOwner.id',
      'detailsOwner.user_id',
      'detailsRawOwner.id',
      'detailsRawOwner.user_id',
      'owner.id',
      'owner.user_id',
      'user.id',
      'userID'
    ]);

    let fallbackClauseAmount: number | null = null;
    let fallbackOwnerUserId: number | null = null;
    let fallbackPlayerName: string | null = null;
    let fallbackRaw: Record<string, unknown> | null = null;
    const shouldFallback = (!clauseAmount || clauseAmount <= 0) || !ownerUserId;

    if (shouldFallback) {
      try {
        const leaguePayload = await this.mcp.callTool('biwenger_league_get_details', {
          fields: '*,users(id,name,players(id,name,shortName,owner(clause,clauseValue,clause_amount,releaseClause,buyoutClause,clausePrice)))'
        });
        const extracted = this.extractClauseFromLeagueDetails(leaguePayload, resolvedPlayerId);
        if (extracted) {
          fallbackClauseAmount = extracted.clauseAmount;
          fallbackOwnerUserId = extracted.ownerUserId;
          fallbackPlayerName = extracted.playerName;
          fallbackRaw = extracted.raw;
        }
      } catch (error) {
        this.logger.debug('League details fallback failed while resolving clause info', {
          action: 'clause_info_league_fallback_failed',
          player_id: resolvedPlayerId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const normalizedClauseAmount = (clauseAmount !== null && clauseAmount > 0)
      ? clauseAmount
      : fallbackClauseAmount;

    return {
      playerId: resolvedPlayerId,
      playerName: playerName ?? fallbackPlayerName,
      clauseAmount: normalizedClauseAmount,
      ownerUserId: ownerUserId ?? fallbackOwnerUserId,
      raw: {
        ...source,
        fallback: fallbackRaw
      }
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
      'market_list',
      'marketList',
      'dailyMarket',
      'publicMarket',
      'public_market',
      'data.market',
      'data.players',
      'data.marketPlayers',
      'data.market_list',
      'data.marketList',
      'data.dailyMarket',
      'data.publicMarket',
      'raw.market',
      'raw.players',
      'raw.marketPlayers',
      'raw.market_list',
      'raw.marketList',
      'raw.data.market',
      'raw.data.players',
      'raw.data.marketPlayers',
      'raw.data.market_list',
      'raw.data.marketList',
      'snapshot.dailyMarket',
      'snapshot.market',
      'snapshot.players',
      'snapshot.marketPlayers'
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

    const previousPriceRaw = pickFirstNumber(source, [
      'previousPrice',
      'previous_price',
      'prevPrice',
      'lastPrice',
      'last_price',
      'oldPrice',
      'old_price',
      'priceBefore'
    ]);
    const priceIncrement = pickFirstNumber(source, [
      'priceIncrement',
      'price_increment',
      'increment',
      'deltaPrice',
      'priceDiff'
    ]);
    const previousPrice = previousPriceRaw
      ?? ((currentPrice !== null && priceIncrement !== null) ? currentPrice - priceIncrement : null);

    return {
      playerId,
      playerName,
      currentPrice,
      previousPrice,
      raw: source
    };
  }

  private inferDailyMarketPlayers(
    payload: Record<string, unknown>,
    excluded: Set<number>
  ): DailyMarketSnapshot[] {
    const output = new Map<number, DailyMarketSnapshot>();

    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const entry of node) visit(entry);
        return;
      }

      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const parsed = this.mapDailyMarketPlayer(record);
      if (parsed && !excluded.has(parsed.playerId)) {
        const prev = output.get(parsed.playerId);
        if (!prev || this.scoreDailySnapshot(parsed) > this.scoreDailySnapshot(prev)) {
          output.set(parsed.playerId, parsed);
        }
      }

      for (const value of Object.values(record)) {
        visit(value);
      }
    };

    visit(payload);
    return Array.from(output.values());
  }

  private scoreDailySnapshot(item: DailyMarketSnapshot): number {
    let score = 0;
    if (item.currentPrice !== null) score += 2;
    if (item.previousPrice !== null) score += 1;
    if (!this.isMissingPlayerName(item.playerName)) score += 1;
    return score;
  }

  private isDailyMarketFreeEntry(source: Record<string, unknown>): boolean {
    const ownerUserId = pickFirstPositiveInt(source, [
      'owner_user_id',
      'ownerUserId',
      'owner.id',
      'ownerID',
      'owner_user.id',
      'user.id',
      'userID',
      'raw.owner_user_id',
      'raw.owner.id',
      'raw.user.id'
    ]);
    return ownerUserId === null;
  }

  private extractClauseFromLeagueDetails(
    payload: Record<string, unknown>,
    targetPlayerId: number
  ): {
    clauseAmount: number | null;
    ownerUserId: number | null;
    playerName: string | null;
    raw: Record<string, unknown>;
  } | null {
    const root = asRecord(payload.data);
    const league = asRecord(root.data);
    const users = asArray(league.users);

    for (const entry of users) {
      const user = asRecord(entry);
      const ownerUserId = pickFirstPositiveInt(user, ['id', 'userID', 'user.id']);
      const players = asArray(user.players);

      for (const playerEntry of players) {
        const player = asRecord(playerEntry);
        const playerId = pickFirstPositiveInt(player, ['id', 'player_id', 'playerID']);
        if (!playerId || playerId !== targetPlayerId) continue;

        const owner = asRecord(player.owner);
        const clauseAmount = pickFirstNumber({ player, owner }, [
          'owner.clause',
          'owner.clauseValue',
          'owner.clause_amount',
          'owner.releaseClause',
          'owner.buyoutClause',
          'owner.clausePrice',
          'player.clause',
          'player.clauseValue',
          'player.clause_amount',
          'player.releaseClause',
          'player.buyoutClause',
          'player.clausePrice'
        ]);
        const resolvedOwnerUserId = ownerUserId ?? pickFirstPositiveInt(owner, [
          'id',
          'user_id',
          'userID'
        ]);
        const playerName = pickFirstString(player, [
          'name',
          'shortName',
          'displayName',
          'fullName'
        ]);

        return {
          clauseAmount,
          ownerUserId: resolvedOwnerUserId,
          playerName,
          raw: {
            user,
            player,
            owner
          }
        };
      }
    }

    return null;
  }
}
