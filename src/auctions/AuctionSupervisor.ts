import type { BiwengerAuctionSettings, SetAuctionStateInput } from './BiwengerAuctionSettings.js';
import { auctionWindow } from './AuctionSchedule.js';
import { marketSummary, verifyMarket } from './AuctionMarketHealth.js';

export async function superviseCycle(options: {
  service: Pick<BiwengerAuctionSettings, 'setState' | 'inspect'>;
  credentials: Omit<SetAuctionStateInput, 'enabled' | 'writeDeadline'>;
  hasSuccessfulRun: (since: Date) => Promise<boolean>;
  now?: () => Date;
}): Promise<null | {
  phase: 'preflight' | 'postcycle';
  repaired: boolean;
  problems: string[];
  summary?: ReturnType<typeof marketSummary>;
}> {
  const clock = options.now ?? (() => new Date());
  const now = clock();
  const window = auctionWindow(now);
  if (!window) return null;
  const { service, credentials } = options;
  const enabled = window.action === 'open';
  let repaired = false;
  const problems: string[] = [];
  if (window.phase === 'preflight') {
    const current = auctionWindow(clock());
    if (!current || current.phase !== 'preflight' || current.action !== window.action) {
      throw new Error('Preflight repair deadline has passed');
    }
    const result = await service.setState({ ...credentials, enabled, writeDeadline: window.cycle });
    repaired = result.changed;
  }
  const state = await service.inspect(credentials, window.phase === 'postcycle');
  if (state.enabled !== enabled || state.freePlayers !== (enabled ? 15 : 0)) {
    problems.push(`Configuracion incorrecta: se esperaba auctions=${enabled}, auctionsFreePlayers=${enabled ? 15 : 0}. Revisar antes del siguiente ciclo.`);
  }
  if (now.getTime() >= window.start.getTime() + 90 * 60000 && !await options.hasSuccessfulRun(window.start)) {
    problems.push('No consta una ejecucion correcta del workflow principal en esta ventana. El supervisor comprueba y, antes de las 07:00, repara los ajustes; revisar tambien el cron principal.');
  }
  let summary: ReturnType<typeof marketSummary> | undefined;
  if (window.phase === 'postcycle') {
    summary = marketSummary(state.market, window.cycle, clock());
    try { verifyMarket(summary, enabled); }
    catch (error) { problems.push(error instanceof Error ? error.message : 'Post-cycle market verification failed'); }
  }
  return { phase: window.phase, repaired, problems, summary };
}
