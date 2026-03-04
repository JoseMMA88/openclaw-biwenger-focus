import { createHash } from 'node:crypto';

export function shortHash(payload: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return digest.slice(0, 24);
}
