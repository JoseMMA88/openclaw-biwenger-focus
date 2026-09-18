import { BiwengerAuctionSettings } from './BiwengerAuctionSettings.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function leagueIdFromEnv(): number {
  const value = Number(requiredEnv('BIWENGER_LEAGUE_ID'));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('BIWENGER_LEAGUE_ID must be a positive integer');
  }
  return value;
}

function desiredState(action: string | undefined): boolean {
  if (action === 'open') return true;
  if (action === 'close') return false;
  throw new Error('Action must be either open or close');
}

async function main(): Promise<void> {
  const enabled = desiredState(process.argv[2]);
  const result = await new BiwengerAuctionSettings().setState({
    email: requiredEnv('BIWENGER_EMAIL'),
    password: requiredEnv('BIWENGER_PASSWORD'),
    leagueId: leagueIdFromEnv(),
    enabled
  });

  const state = enabled ? 'open' : 'closed';
  console.log(result.changed
    ? `Biwenger auctions changed to ${state} and verified.`
    : `Biwenger auctions were already ${state}; no change was sent.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Auction settings failed: ${message}`);
  process.exitCode = 1;
});
