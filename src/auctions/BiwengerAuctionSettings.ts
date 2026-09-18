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

interface LeagueSettings {
  auctions: boolean;
}

interface League {
  name: string;
  scoreID: number;
  icon: string | null;
  cover: string | null;
  settings: LeagueSettings;
}

type Fetcher = typeof fetch;

const API_URL = 'https://biwenger.as.com/api/v2';

export class BiwengerAuctionSettings {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async setState(input: SetAuctionStateInput): Promise<SetAuctionStateResult> {
    const token = await this.login(input.email, input.password);
    const current = await this.getLeague(input.leagueId, token);

    if (current.settings.auctions === input.enabled) {
      return { changed: false, enabled: input.enabled };
    }

    await this.updateLeague(input.leagueId, token, current, input.enabled);
    const verified = await this.getLeague(input.leagueId, token);
    if (verified.settings.auctions !== input.enabled) {
      throw new Error(`Biwenger did not persist auctions=${input.enabled}`);
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

  private async getLeague(leagueId: number, token: string): Promise<League> {
    const response = await this.request(this.leaguePath(leagueId), {
      method: 'GET',
      headers: this.authorization(token)
    });

    return this.asLeague(this.asRecord(response).data);
  }

  private async updateLeague(leagueId: number, token: string, league: League, enabled: boolean): Promise<void> {
    await this.request(this.leaguePath(leagueId), {
      method: 'PUT',
      headers: this.authorization(token),
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
      settings: { auctions: settings.auctions }
    };
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
