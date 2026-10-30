import { describe, expect, it, vi } from 'vitest';
import { reportAlert } from '../../scripts/auction-alert.mjs';

const options = { token: 'secret', repository: 'test/repo', key: 'primary', state: 'failure', message: 'Network failure', runUrl: 'https://github.com/test/repo/actions/runs/1' };
const json = (data: unknown) => new Response(JSON.stringify(data));

describe('GitHub incident alerts', () => {
  it('creates one managed issue then deduplicates repeated failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json([])).mockResolvedValueOnce(json({ number: 1 }));
    expect(await reportAlert({ ...options, fetcher })).toBe('created');
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    fetcher.mockResolvedValueOnce(json([{ number: 1, ...body }]));
    expect(await reportAlert({ ...options, fetcher })).toBe('unchanged');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not modify an unmanaged issue with the same title', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ number: 12, title: '[Biwenger auctions] primary', body: 'Manual issue' }]))
      .mockResolvedValueOnce(json({ number: 13 }));
    expect(await reportAlert({ ...options, fetcher })).toBe('created');
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.github.com/repos/test/repo/issues');
  });

  it('closes a managed incident on recovery', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ number: 1, title: '[Biwenger auctions] primary', body: '<!-- biwenger-auction-alert:primary -->' }]))
      .mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({}));
    expect(await reportAlert({ ...options, state: 'recovered', fetcher })).toBe('resolved');
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({ state: 'closed' });
  });

  it('does not expose raw transport errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private token secret'));
    await expect(reportAlert({ ...options, fetcher })).rejects.toThrow('GitHub alert request failed or timed out');
  });
});
