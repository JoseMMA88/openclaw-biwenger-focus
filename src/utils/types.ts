export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toPositiveIntOrNull(value: unknown): number | null {
  const parsed = toNumberOrNull(value);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function pickFirstPositiveInt(source: Record<string, unknown>, paths: string[]): number | null {
  for (const path of paths) {
    const value = getByPath(source, path);
    const parsed = toPositiveIntOrNull(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function pickFirstNumber(source: Record<string, unknown>, paths: string[]): number | null {
  for (const path of paths) {
    const value = getByPath(source, path);
    const parsed = toNumberOrNull(value);
    if (parsed !== null) return Math.floor(parsed);
  }
  return null;
}

export function pickFirstString(source: Record<string, unknown>, paths: string[]): string | null {
  for (const path of paths) {
    const value = getByPath(source, path);
    const parsed = toStringOrNull(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function getByPath(source: Record<string, unknown>, path: string): unknown {
  const chunks = path.split('.');
  let cursor: unknown = source;

  for (const chunk of chunks) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    if (!Object.hasOwn(cursor, chunk)) return undefined;
    cursor = (cursor as Record<string, unknown>)[chunk];
  }

  return cursor;
}
