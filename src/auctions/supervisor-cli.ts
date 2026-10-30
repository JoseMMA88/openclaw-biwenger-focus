import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { BiwengerAuctionSettings } from './BiwengerAuctionSettings.js';
import { auctionWindow } from './AuctionSchedule.js';
import { marketSummary } from './AuctionMarketHealth.js';
import { superviseCycle } from './AuctionSupervisor.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function github(path: string): Promise<Record<string, unknown>> {
  const repository = required('GITHUB_REPOSITORY');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      headers: { Authorization: `Bearer ${required('GITHUB_TOKEN')}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000)
    });
  } catch { throw new Error('GitHub supervision request failed or timed out'); }
  if (!response.ok) throw new Error(`GitHub supervision request failed with HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function alert(key: string, problems: string[], healthy: string): void {
  const result = spawnSync(process.execPath, ['scripts/auction-alert.mjs'], {
    env: { ...process.env, AUCTION_ALERT_KEY: key,
      AUCTION_ALERT_STATE: problems.length ? 'failure' : 'recovered',
      AUCTION_ALERT_MESSAGE: problems.length ? problems.join('\n\n') : healthy },
    stdio: 'inherit'
  });
  if (result.status !== 0) throw new Error('Could not deliver GitHub supervision alert');
}

async function main(): Promise<void> {
  const now = new Date();
  const window = auctionWindow(now);
  const workflow = await github('/actions/workflows/biwenger-auctions.yml');
  const workflowProblems = workflow.state === 'active' ? [] : ['El workflow principal no esta activo. Revisar su estado y reactivarlo si procede.'];
  alert('workflow', workflowProblems, 'El workflow principal esta activo.');
  if (workflowProblems.length) process.exitCode = 1;
  if (!window && process.argv[2] !== '--diagnostic') {
    console.log('No auction-cycle window; workflow availability checked.');
    return;
  }
  const leagueId = Number(required('BIWENGER_LEAGUE_ID'));
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) throw new Error('Invalid league ID');
  const input = { email: required('BIWENGER_EMAIL'), password: required('BIWENGER_PASSWORD'), leagueId };
  const service = new BiwengerAuctionSettings();
  if (!window) {
    const state = await service.inspect(input, true);
    const summary = marketSummary(state.market, now, now);
    console.log(`Read-only diagnostics: auctions=${state.enabled}, freePlayers=${state.freePlayers}, market=${JSON.stringify(summary)}`);
    return;
  }
  const result = await superviseCycle({
    service, credentials: input,
    hasSuccessfulRun: async (start) => {
      const since = encodeURIComponent(`>=${start.toISOString()}`);
      const runs = await github(`/actions/workflows/biwenger-auctions.yml/runs?branch=main&per_page=100&created=${since}`);
      if (!Array.isArray(runs.workflow_runs)) throw new Error('Unexpected GitHub workflow history response');
      return runs.workflow_runs.some((entry: { conclusion?: string }) => entry.conclusion === 'success');
    }
  });
  if (!result) return;
  console.log(`Auction supervision: ${result.phase}, repaired=${result.repaired}, market=${JSON.stringify(result.summary ?? null)}`);
  alert('cycle', result.problems, 'Configuracion y comprobaciones del ciclo correctas.');
  if (result.problems.length) {
    result.problems.forEach((message) => console.error(message));
    process.exitCode = 1;
  }
}

main().then(() => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'completed=true\n');
}).catch((error: unknown) => {
  // Transport errors are sanitized by the HTTP client; never publish raw credentials or payloads.
  console.error(error instanceof Error ? error.message : 'Auction supervision failed');
  process.exitCode = 1;
});
