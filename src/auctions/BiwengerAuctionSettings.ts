import { isDeepStrictEqual } from 'node:util';
import { BiwengerHttpClient, BiwengerHttpError, type BiwengerHttpClientOptions } from './BiwengerHttpClient.js';

export interface SetAuctionStateInput {
  email: string;
  password: string;
  leagueId: number;
  enabled: boolean;
  writeDeadline?: Date;
}

export interface SetAuctionStateResult {
  changed: boolean;
  enabled: boolean;
}

interface LeagueSettings extends Record<string, unknown> {
  auctions: boolean;
  auctionsFreePlayers: number;
}

interface League {
  name: string;
  scoreID: number;
  icon: string | null;
  cover: string | null;
  settings: LeagueSettings;
}

interface LeagueSession {
  token: string;
  userId: number;
}

type Fetcher = typeof fetch;

const OPEN_AUCTIONS_FREE_PLAYERS = 15;
const CLOSED_AUCTIONS_FREE_PLAYERS = 0;

export class BiwengerAuctionSettings {
  private readonly client: BiwengerHttpClient;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(fetcher: Fetcher = fetch, options: BiwengerHttpClientOptions = {}) {
    this.client = new BiwengerHttpClient(fetcher, options);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async inspect(input: Omit<SetAuctionStateInput, 'enabled'>, includeMarket = false): Promise<{
    enabled: boolean;
    freePlayers: number;
    market?: unknown;
  }> {
    const token = await this.login(input.email, input.password);
    const session = await this.getLeagueSession(input.leagueId, token);
    const league = await this.getLeague(input.leagueId, session);
    const market = includeMarket ? await this.request('/market', {
      method: 'GET', headers: this.leagueAuthorization(input.leagueId, session)
    }) : undefined;
    return { enabled: league.settings.auctions, freePlayers: league.settings.auctionsFreePlayers, market };
  }

  async setState(input: SetAuctionStateInput): Promise<SetAuctionStateResult> {
    const token = await this.login(input.email, input.password);
    const session = await this.getLeagueSession(input.leagueId, token);
    const current = await this.getLeague(input.leagueId, session);
    const freePlayers = input.enabled
      ? OPEN_AUCTIONS_FREE_PLAYERS
      : CLOSED_AUCTIONS_FREE_PLAYERS;

    if (current.settings.auctions === input.enabled
      && current.settings.auctionsFreePlayers === freePlayers) {
      return { changed: false, enabled: input.enabled };
    }

    let latest = current;
    let verified = current;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (input.writeDeadline && Date.now() >= input.writeDeadline.getTime()) {
        throw new Error('Auction write deadline has passed; manual review required');
      }
      let writeError: BiwengerHttpError | undefined;
      try {
        await this.updateLeague(input.leagueId, session, latest, input.enabled, freePlayers);
      } catch (error) {
        if (!(error instanceof BiwengerHttpError) || !error.retryable) throw error;
        writeError = error;
      }
      // A timed-out PUT may already have committed: read before considering another write.
      verified = await this.getLeague(input.leagueId, session);
      const unrelatedChanges = this.changedSettings(current.settings, verified.settings);
      if (unrelatedChanges.length > 0) {
        throw new Error(`Biwenger changed unrelated settings: ${unrelatedChanges.join(', ')}`);
      }
      if (verified.settings.auctions === input.enabled && verified.settings.auctionsFreePlayers === freePlayers) break;
      if (!writeError || attempt === 1) {
        if (writeError) throw writeError;
        break;
      }
      await this.sleep(writeError.retryAfterMs);
      latest = verified;
    }
    if (verified.settings.auctions !== input.enabled) {
      throw new Error(`Biwenger did not persist auctions=${input.enabled}`);
    }
    if (verified.settings.auctionsFreePlayers !== freePlayers) {
      throw new Error(`Biwenger did not persist auctionsFreePlayers=${freePlayers}`);
    }

    return { changed: true, enabled: input.enabled };
  }

  private async login(email: string, password: string): Promise<string> {
    const response = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    const token = this.asRecord(response).token;

    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('Biwenger login did not return a session token');
    }

    return token;
  }

  private async getLeagueSession(leagueId: number, token: string): Promise<LeagueSession> {
    const response = await this.request('/account', {
      method: 'GET',
      headers: this.authorization(token)
    });
    const account = this.asRecord(this.asRecord(response).data);
    const leagues = Array.isArray(account.leagues) ? account.leagues : [];
    const selected = leagues
      .map((entry) => this.asRecord(entry))
      .find((entry) => Number(entry.id) === leagueId);
    const user = selected ? this.asRecord(selected.user) : null;
    const userId = Number(user?.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error(`League ${leagueId} is not available for this Biwenger account`);
    }

    return { token, userId };
  }

  private async getLeague(leagueId: number, session: LeagueSession): Promise<League> {
    const response = await this.request(this.leaguePath(leagueId), {
      method: 'GET',
      headers: this.leagueAuthorization(leagueId, session)
    });

    return this.asLeague(this.asRecord(response).data);
  }

  private async updateLeague(
    leagueId: number,
    session: LeagueSession,
    league: League,
    enabled: boolean,
    freePlayers: number
  ): Promise<void> {
    await this.request(this.leaguePath(leagueId), {
      method: 'PUT',
      headers: this.leagueAuthorization(leagueId, session),
      body: JSON.stringify({
        name: league.name,
        scoreID: league.scoreID,
        icon: league.icon,
        cover: league.cover,
        settings: {
          auctions: enabled,
          auctionsFreePlayers: freePlayers
        }
      })
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    return this.client.request(path, init);
  }

  private leaguePath(leagueId: number): string {
    return `/league/${leagueId}?fields=*,settings`;
  }

  private authorization(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  private leagueAuthorization(leagueId: number, session: LeagueSession): Record<string, string> {
    return {
      ...this.authorization(session.token),
      'X-League': String(leagueId),
      'X-User': String(session.userId)
    };
  }

  private asLeague(value: unknown): League {
    const league = this.asRecord(value);
    const settings = this.asRecord(league.settings);

    if (typeof league.name !== 'string'
      || typeof league.scoreID !== 'number'
      || !this.isNullableString(league.icon)
      || !this.isNullableString(league.cover)
      || typeof settings.auctions !== 'boolean'
      || !Number.isInteger(settings.auctionsFreePlayers)
      || Number(settings.auctionsFreePlayers) < 0
      || Number(settings.auctionsFreePlayers) > 20) {
      throw new Error('Biwenger returned an unexpected league response');
    }

    return {
      name: league.name,
      scoreID: league.scoreID,
      icon: league.icon,
      cover: league.cover,
      settings: {
        ...settings,
        auctions: settings.auctions,
        auctionsFreePlayers: Number(settings.auctionsFreePlayers)
      }
    };
  }

  private changedSettings(before: LeagueSettings, after: LeagueSettings): string[] {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    keys.delete('auctions');
    keys.delete('auctionsFreePlayers');

    return [...keys]
      .filter((key) => !isDeepStrictEqual(before[key], after[key]))
      .sort();
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Biwenger returned an unexpected response');
    }

    return value as Record<string, unknown>;
  }

  private isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
  }
}
