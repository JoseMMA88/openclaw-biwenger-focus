import { describe, expect, it, vi } from 'vitest';

import { BiwengerAuctionSettings } from '../../src/auctions/BiwengerAuctionSettings.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const league = {
  id: 1500231,
  name: 'Los Invencibles del Siglo X.X',
  scoreID: 1,
  icon: 'league-icon',
  cover: 'league-cover',
  settings: { auctions: false, auctionsFreePlayers: 20 }
};

const account = {
  leagues: [{ id: 1500231, user: { id: 9876 } }]
};

describe('BiwengerAuctionSettings', () => {
  it('opens auctions with the exact settings diff and verifies the result', async () => {
    const openLeague = {
      ...league,
      settings: { ...league.settings, auctions: true, auctionsFreePlayers: 15 }
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: account }))
      .mockResolvedValueOnce(jsonResponse({ data: league }))
      .mockResolvedValueOnce(jsonResponse({ data: openLeague }))
      .mockResolvedValueOnce(jsonResponse({ data: openLeague }));
    const service = new BiwengerAuctionSettings(fetchMock);

    const result = await service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    });

    expect(result).toEqual({ changed: true, enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenNthCalledWith(4,
      'https://biwenger.as.com/api/v2/league/1500231?fields=*,settings',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          name: league.name,
          scoreID: league.scoreID,
          icon: league.icon,
          cover: league.cover,
          settings: { auctions: true, auctionsFreePlayers: 15 }
        })
      })
    );
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer session-token',
      'X-Lang': 'es',
      'X-Version': '631',
      'X-League': '1500231',
      'X-User': '9876'
    }));
  });

  it('closes auctions and removes free players from the auction market', async () => {
    const openLeague = {
      ...league,
      settings: { ...league.settings, auctions: true, auctionsFreePlayers: 15 }
    };
    const closedLeague = {
      ...league,
      settings: { ...league.settings, auctions: false, auctionsFreePlayers: 0 }
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: account }))
      .mockResolvedValueOnce(jsonResponse({ data: openLeague }))
      .mockResolvedValueOnce(jsonResponse({ data: closedLeague }))
      .mockResolvedValueOnce(jsonResponse({ data: closedLeague }));
    const service = new BiwengerAuctionSettings(fetchMock);

    const result = await service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: false
    });

    expect(result).toEqual({ changed: true, enabled: false });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      name: league.name,
      scoreID: league.scoreID,
      icon: league.icon,
      cover: league.cover,
      settings: { auctions: false, auctionsFreePlayers: 0 }
    });
  });

  it('does not write when both auction settings already have the requested state', async () => {
    const openLeague = {
      ...league,
      settings: { ...league.settings, auctions: true, auctionsFreePlayers: 15 }
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: account }))
      .mockResolvedValueOnce(jsonResponse({ data: openLeague }));
    const service = new BiwengerAuctionSettings(fetchMock);

    const result = await service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    });

    expect(result).toEqual({ changed: false, enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('corrects the free-player count when the switch already has the requested state', async () => {
    const openLeague = { ...league, settings: { ...league.settings, auctions: true } };
    const correctedLeague = {
      ...league,
      settings: { ...league.settings, auctions: true, auctionsFreePlayers: 15 }
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: account }))
      .mockResolvedValueOnce(jsonResponse({ data: openLeague }))
      .mockResolvedValueOnce(jsonResponse({ data: correctedLeague }))
      .mockResolvedValueOnce(jsonResponse({ data: correctedLeague }));
    const service = new BiwengerAuctionSettings(fetchMock);

    const result = await service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    });

    expect(result).toEqual({ changed: true, enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('fails when Biwenger does not persist the requested state', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: account }))
      .mockResolvedValueOnce(jsonResponse({ data: league }))
      .mockResolvedValueOnce(jsonResponse({ data: league }))
      .mockResolvedValueOnce(jsonResponse({ data: league }));
    const service = new BiwengerAuctionSettings(fetchMock);

    await expect(service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    })).rejects.toThrow('Biwenger did not persist auctions=true');
  });

  it('fails when Biwenger does not persist the requested free-player count', async () => {
    const switchOnlyLeague = {
      ...league,
      settings: { ...league.settings, auctions: true }
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: account }))
      .mockResolvedValueOnce(jsonResponse({ data: league }))
      .mockResolvedValueOnce(jsonResponse({ data: switchOnlyLeague }))
      .mockResolvedValueOnce(jsonResponse({ data: switchOnlyLeague }));
    const service = new BiwengerAuctionSettings(fetchMock);

    await expect(service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    })).rejects.toThrow('Biwenger did not persist auctionsFreePlayers=15');
  });

  it('fails when Biwenger changes a setting unrelated to auctions', async () => {
    const changedLeague = {
      ...league,
      settings: { ...league.settings, auctions: true, auctionsFreePlayers: 15, clauses: true }
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: account }))
      .mockResolvedValueOnce(jsonResponse({ data: league }))
      .mockResolvedValueOnce(jsonResponse({ data: changedLeague }))
      .mockResolvedValueOnce(jsonResponse({ data: changedLeague }));
    const service = new BiwengerAuctionSettings(fetchMock);

    await expect(service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    })).rejects.toThrow('Biwenger changed unrelated settings: clauses');
  });

  it('identifies a failed operation without exposing its request body', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid credentials' }, 400));
    const service = new BiwengerAuctionSettings(fetchMock);

    await expect(service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    })).rejects.toThrow('Biwenger POST /auth/login failed with HTTP 400');
  });
});
