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
  primaryWarning?: string;
  summary?: ReturnType<typeof marketSummary>;
}> {
  const clock = options.now ?? (() => new Date());
  const now = clock();
  const window = auctionWindow(now);
  if (!window) return null;
  const { service, credentials } = options;
  const enabled = window.action === 'open';
  const freePlayers = enabled ? 15 : 0;
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
  if (state.enabled !== enabled || state.freePlayers !== freePlayers) {
    problems.push(`Configuracion incorrecta: se esperaba auctions=${enabled}, auctionsFreePlayers=${freePlayers}. Revisar antes del siguiente ciclo.`);
  }
  let summary: ReturnType<typeof marketSummary> | undefined;
  if (window.phase === 'postcycle') {
    summary = marketSummary(state.market, window.cycle, clock());
    try { verifyMarket(summary, enabled); }
    catch (error) { problems.push(error instanceof Error ? error.message : 'Post-cycle market verification failed'); }
  }
  let primaryWarning: string | undefined;
  if (now.getTime() >= window.start.getTime() + 90 * 60000 && !await options.hasSuccessfulRun(window.start)) {
    const situation = problems.length > 0
      ? 'El estado de Biwenger requiere revisión; consulta las comprobaciones anteriores.'
      : `El supervisor ha verificado los ajustes de ${enabled ? 'apertura' : 'cierre'} en Biwenger (auctions=${enabled}, auctionsFreePlayers=${freePlayers}). No hace falta intervenir en la liga.`;
    primaryWarning = `Aviso de puntualidad: no consta una ejecución correcta del workflow principal en esta ventana. ${situation}`;
  }
  return { phase: window.phase, repaired, problems, primaryWarning, summary };
}
