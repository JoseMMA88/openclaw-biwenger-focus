import { existsSync, readFileSync } from 'node:fs';
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
  biddingPollSec: number;
  armedMaxPollSec: number;
  marketReportEnabled: boolean;
  marketReportTickSec: number;
  marketReportOpeningOnly: boolean;
  marketReportHour: number;
  marketReportMinute: number;
  marketReportTopLimit: number;
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
  market_report_enabled?: unknown;
  market_report_tick_sec?: unknown;
  market_report_opening_only?: unknown;
  market_report_hour?: unknown;
  market_report_minute?: unknown;
  market_report_top_limit?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readOpenClawPluginConfig(env: NodeJS.ProcessEnv): OpenClawRuntimeConfig {
  const candidates = [
    toStringValue(env.OPENCLAW_CONFIG_PATH),
    env.HOME ? resolve(env.HOME, '.openclaw/openclaw.json') : null
  ].filter((entry): entry is string => Boolean(entry));

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const root = asRecord(JSON.parse(readFileSync(candidate, 'utf8')));
      const plugins = asRecord(root?.plugins);
      const entries = asRecord(plugins?.entries);
      const entry = asRecord(entries?.['biwenger-focus']);
      const config = asRecord(entry?.config);
      if (config) return config;
    } catch {
      // Ignore malformed or inaccessible host config; OpenClaw validation reports those separately.
    }
  }

  return {};
}

function normalizeRuntimeConfig(value: OpenClawRuntimeConfig): OpenClawRuntimeConfig {
  const record = asRecord(value);
  const nested = asRecord(record?.config);
  return {
    ...record,
    ...nested
  };
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

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
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
  const fileConfig = readOpenClawPluginConfig(env);
  const effectiveConfig = {
    ...fileConfig,
    ...normalizeRuntimeConfig(rawConfig)
  };

  const configuredMcpCommand = toStringValue(effectiveConfig.mcp_command) ?? toStringValue(env.MCP_COMMAND);
  const mcpCommand = (() => {
    if (!configuredMcpCommand) return process.execPath || '/usr/bin/node';
    if (configuredMcpCommand === 'node') return process.execPath || configuredMcpCommand;
    return configuredMcpCommand;
  })();
  const defaultMcpEntry = '/opt/biwenger-mcp/dist/server.js';
  const mcpArgs = parseMcpArgs(effectiveConfig.mcp_args ?? env.MCP_ARGS, defaultMcpEntry);
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
  const configuredMcpCwd = toStringValue(effectiveConfig.mcp_cwd) ?? toStringValue(env.MCP_CWD) ?? inferredMcpCwd;
  const mcpCwd = configuredMcpCwd && existsSync(resolve(configuredMcpCwd))
    ? resolve(configuredMcpCwd)
    : undefined;

  const dbPathRaw = toStringValue(effectiveConfig.db_path) ?? env.FOCUS_DB_PATH ?? '/var/lib/openclaw/biwenger-focus.db';
  const dbPath = resolve(dbPathRaw);

  const telegramBotToken = toStringValue(effectiveConfig.telegram_bot_token) ?? toStringValue(env.TELEGRAM_BOT_TOKEN);
  const telegramChatId = toStringValue(effectiveConfig.telegram_chat_id) ?? toStringValue(env.TELEGRAM_CHAT_ID);

  const tz = toStringValue(effectiveConfig.tz) ?? env.TZ ?? 'Europe/Madrid';
  const logLevel = (toStringValue(effectiveConfig.log_level) ?? env.LOG_LEVEL ?? 'info') as LogLevel;
  const marketReportEnabled = env.MARKET_REPORT_ENABLED !== undefined
    ? toBoolean(env.MARKET_REPORT_ENABLED, true)
    : toBoolean(effectiveConfig.market_report_enabled, true);

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
    biddingPollSec: toPositiveInt(env.FOCUS_BIDDING_POLL_SEC, 900),
    armedMaxPollSec: toPositiveInt(env.FOCUS_ARMED_MAX_POLL_SEC, 900),
    marketReportEnabled,
    marketReportTickSec: toPositiveInt(effectiveConfig.market_report_tick_sec ?? env.MARKET_REPORT_TICK_SEC, 60),
    marketReportOpeningOnly: toBoolean(effectiveConfig.market_report_opening_only ?? env.MARKET_REPORT_OPENING_ONLY, true),
    marketReportHour: Math.max(0, Math.min(23, toPositiveInt(effectiveConfig.market_report_hour ?? env.MARKET_REPORT_HOUR, 9))),
    marketReportMinute: Math.max(0, Math.min(59, toPositiveInt(effectiveConfig.market_report_minute ?? env.MARKET_REPORT_MINUTE, 0))),
    marketReportTopLimit: toPositiveInt(effectiveConfig.market_report_top_limit ?? env.MARKET_REPORT_TOP_LIMIT, 10),
    defaults: {
      startWhenRemainingSec: 3600,
      bidStep: 50000,
      pollSec: 20,
      cooldownSec: 75
    }
  };
}
