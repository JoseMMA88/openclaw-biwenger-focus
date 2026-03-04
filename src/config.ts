import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import type { LogLevel } from './logger.js';

export interface PluginConfig {
  mcpCommand: string;
  mcpArgs: string[];
  mcpCwd?: string;
  dbPath: string;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  tz: string;
  logLevel: LogLevel;
  lockTtlSec: number;
  missingTimeoutSec: number;
  tickSec: number;
  maxConsecutiveErrors: number;
  defaults: {
    startWhenRemainingSec: number;
    bidStep: number;
    pollSec: number;
    cooldownSec: number;
  };
}

export interface OpenClawRuntimeConfig {
  mcp_command?: unknown;
  mcp_args?: unknown;
  mcp_cwd?: unknown;
  db_path?: unknown;
  telegram_bot_token?: unknown;
  telegram_chat_id?: unknown;
  tz?: unknown;
  log_level?: unknown;
}

function toStringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseMcpArgs(value: unknown, fallback: string): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return parseMcpArgs(parsed, fallback);
      } catch {
        return [fallback];
      }
    }

    if (trimmed.includes(',')) {
      return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
    }

    return trimmed.length > 0 ? [trimmed] : [fallback];
  }

  return [fallback];
}

export function loadConfig(rawConfig: OpenClawRuntimeConfig = {}, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const configuredMcpCommand = toStringValue(rawConfig.mcp_command) ?? toStringValue(env.MCP_COMMAND);
  const mcpCommand = (() => {
    if (!configuredMcpCommand) return process.execPath || '/usr/bin/node';
    if (configuredMcpCommand === 'node') return process.execPath || configuredMcpCommand;
    return configuredMcpCommand;
  })();
  const defaultMcpEntry = '/opt/biwenger-mcp/dist/server.js';
  const mcpArgs = parseMcpArgs(rawConfig.mcp_args ?? env.MCP_ARGS, defaultMcpEntry);
  const mcpEntry = mcpArgs[0];
  const inferredMcpCwd = (() => {
    if (!mcpEntry) return undefined;
    const resolvedEntry = resolve(mcpEntry);
    const entryDir = dirname(resolvedEntry);
    if (basename(entryDir) === 'dist') {
      return dirname(entryDir);
    }
    return entryDir;
  })();
  const configuredMcpCwd = toStringValue(rawConfig.mcp_cwd) ?? toStringValue(env.MCP_CWD) ?? inferredMcpCwd;
  const mcpCwd = configuredMcpCwd && existsSync(resolve(configuredMcpCwd))
    ? resolve(configuredMcpCwd)
    : undefined;

  const dbPathRaw = toStringValue(rawConfig.db_path) ?? env.FOCUS_DB_PATH ?? '/var/lib/openclaw/biwenger-focus.db';
  const dbPath = resolve(dbPathRaw);

  const telegramBotToken = toStringValue(rawConfig.telegram_bot_token) ?? toStringValue(env.TELEGRAM_BOT_TOKEN);
  const telegramChatId = toStringValue(rawConfig.telegram_chat_id) ?? toStringValue(env.TELEGRAM_CHAT_ID);

  const tz = toStringValue(rawConfig.tz) ?? env.TZ ?? 'Europe/Madrid';
  const logLevel = (toStringValue(rawConfig.log_level) ?? env.LOG_LEVEL ?? 'info') as LogLevel;

  return {
    mcpCommand,
    mcpArgs,
    mcpCwd,
    dbPath,
    telegramBotToken,
    telegramChatId,
    tz,
    logLevel,
    lockTtlSec: toPositiveInt(env.FOCUS_LOCK_TTL_SEC, 30),
    missingTimeoutSec: toPositiveInt(env.FOCUS_MISSING_TIMEOUT_SEC, 600),
    tickSec: toPositiveInt(env.FOCUS_TICK_SEC, 2),
    maxConsecutiveErrors: toPositiveInt(env.FOCUS_MAX_CONSECUTIVE_ERRORS, 15),
    defaults: {
      startWhenRemainingSec: 3600,
      bidStep: 50000,
      pollSec: 20,
      cooldownSec: 75
    }
  };
}
