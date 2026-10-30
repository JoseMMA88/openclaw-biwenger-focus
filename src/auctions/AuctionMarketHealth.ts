function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Biwenger market response');
  return value as Record<string, unknown>;
}

function epoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return epoch(numeric);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return null;
}

export function marketSummary(payload: unknown, cycle: Date, now: Date): {
  activeFree: number;
  newFree: number;
  undatedFree: number;
} {
  const root = record(payload);
  const market = root.data === undefined ? root : record(root.data);
  // The official client uses auctions ?? []: empty markets omit this collection.
  const recognizedEmpty = !Object.hasOwn(market, 'auctions') && Array.isArray(market.sales)
    && Array.isArray(market.offers) && market.status !== null && typeof market.status === 'object';
  if ((!Object.hasOwn(market, 'auctions') && !recognizedEmpty)
    || (market.auctions !== undefined && market.auctions !== null && !Array.isArray(market.auctions))) {
    throw new Error('Biwenger market response has no recognized auctions collection');
  }
  let activeFree = 0;
  let newFree = 0;
  let undatedFree = 0;
  const auctions = Array.isArray(market.auctions) ? market.auctions : [];
  for (const value of auctions) {
    const auction = record(value);
    if (auction.user !== undefined && auction.user !== null) {
      const user = record(auction.user);
      if (typeof user.id !== 'number' || user.id <= 0) throw new Error('Unexpected auction seller response');
      continue;
    }
    const until = epoch(auction.until);
    if (until === null) throw new Error('Auction expiry cannot be verified');
    if (until <= now.getTime()) continue;
    activeFree++;
    const created = epoch(auction.date);
    if (created === null) undatedFree++;
    else {
      if (created > now.getTime() + 300000) throw new Error('Unexpected future auction creation date');
      if (created >= cycle.getTime() - 300000) newFree++;
    }
  }
  return { activeFree, newFree, undatedFree };
}

export function verifyMarket(summary: ReturnType<typeof marketSummary>, enabled: boolean): void {
  if (enabled && summary.newFree === 0) throw new Error('No free-player auctions from the current cycle could be confirmed');
  if (!enabled && summary.newFree > 0) throw new Error('New free-player auctions appeared after the closing cycle');
  if (!enabled && summary.undatedFree > 0) throw new Error('Free-player auctions have no creation date; closing cycle cannot be confirmed');
}
