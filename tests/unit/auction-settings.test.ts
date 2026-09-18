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

describe('BiwengerAuctionSettings', () => {
  it('opens auctions with the exact settings diff and verifies the result', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: league }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...league, settings: { ...league.settings, auctions: true } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...league, settings: { ...league.settings, auctions: true } } }));
    const service = new BiwengerAuctionSettings(fetchMock);

    const result = await service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    });

    expect(result).toEqual({ changed: true, enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(3,
      'https://biwenger.as.com/api/v2/league/1500231?fields=*,settings',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          name: league.name,
          scoreID: league.scoreID,
          icon: league.icon,
          cover: league.cover,
          settings: { auctions: true }
        })
      })
    );
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer session-token'
    }));
  });

  it('does not write when auctions already have the requested state', async () => {
    const openLeague = { ...league, settings: { ...league.settings, auctions: true } };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
      .mockResolvedValueOnce(jsonResponse({ data: openLeague }));
    const service = new BiwengerAuctionSettings(fetchMock);

    const result = await service.setState({
      email: 'admin@example.com',
      password: 'secret',
      leagueId: 1500231,
      enabled: true
    });

    expect(result).toEqual({ changed: false, enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails when Biwenger does not persist the requested state', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'session-token' }))
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
});
