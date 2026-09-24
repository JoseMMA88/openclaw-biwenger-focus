export interface SetAuctionStateInput {
  email: string;
  password: string;
  leagueId: number;
  enabled: boolean;
}

export interface SetAuctionStateResult {
  changed: boolean;
  enabled: boolean;
}

interface LeagueSettings extends Record<string, unknown> {
  auctions: boolean;
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

const API_URL = 'https://biwenger.as.com/api/v2';

export class BiwengerAuctionSettings {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async setState(input: SetAuctionStateInput): Promise<SetAuctionStateResult> {
    const token = await this.login(input.email, input.password);
    const session = await this.getLeagueSession(input.leagueId, token);
    const current = await this.getLeague(input.leagueId, session);

    if (current.settings.auctions === input.enabled) {
      return { changed: false, enabled: input.enabled };
    }

    await this.updateLeague(input.leagueId, session, current, input.enabled);
    const verified = await this.getLeague(input.leagueId, session);
    if (verified.settings.auctions !== input.enabled) {
      throw new Error(`Biwenger did not persist auctions=${input.enabled}`);
    }
    const unrelatedChanges = this.changedSettings(current.settings, verified.settings);
    if (unrelatedChanges.length > 0) {
      throw new Error(`Biwenger changed unrelated settings: ${unrelatedChanges.join(', ')}`);
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

  private async updateLeague(leagueId: number, session: LeagueSession, league: League, enabled: boolean): Promise<void> {
    await this.request(this.leaguePath(leagueId), {
      method: 'PUT',
      headers: this.leagueAuthorization(leagueId, session),
      body: JSON.stringify({
        name: league.name,
        scoreID: league.scoreID,
        icon: league.icon,
        cover: league.cover,
        settings: { auctions: enabled }
      })
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetcher(`${API_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Lang': 'es',
        'X-Version': '631',
        ...init.headers
      }
    });
    const body = await this.readJson(response);

    if (!response.ok) {
      throw new Error(`Biwenger ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}`);
    }

    return body;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('Biwenger returned an invalid JSON response');
    }
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
      || typeof settings.auctions !== 'boolean') {
      throw new Error('Biwenger returned an unexpected league response');
    }

    return {
      name: league.name,
      scoreID: league.scoreID,
      icon: league.icon,
      cover: league.cover,
      settings: { ...settings, auctions: settings.auctions }
    };
  }

  private changedSettings(before: LeagueSettings, after: LeagueSettings): string[] {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    keys.delete('auctions');

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
import { isDeepStrictEqual } from 'node:util';
