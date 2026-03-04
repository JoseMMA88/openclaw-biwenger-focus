import 'dotenv/config';

import { loadConfig, type OpenClawRuntimeConfig } from './config.js';
import { FocusRepository } from './db/FocusRepository.js';
import { SqliteStore } from './db/SqliteStore.js';
import { FocusService } from './focus/FocusService.js';
import { FocusWorker } from './focus/FocusWorker.js';
import { BiwengerGateway } from './gateway/BiwengerGateway.js';
import { Logger } from './logger.js';
import { McpBiwengerClient } from './mcp/McpBiwengerClient.js';
import { CompositeNotifier } from './notify/CompositeNotifier.js';
import { LogNotifier } from './notify/LogNotifier.js';
import type { Notifier } from './notify/Notifier.js';
import { TelegramNotifier } from './notify/TelegramNotifier.js';
import { registerFocusTools } from './tools/FocusTools.js';

interface OpenClawApiLike {
  registerTool?: (tool: Record<string, unknown>) => void | Promise<void>;
  registerService?: (service: {
    id: string;
    name?: string;
    start: () => Promise<void> | void;
    stop: () => Promise<void> | void;
  }) => void | Promise<void>;
  getConfig?: () => OpenClawRuntimeConfig;
  config?: OpenClawRuntimeConfig;
}

class PluginRuntime {
  private readonly api: OpenClawApiLike;
  private readonly logger: Logger;
  private readonly store: SqliteStore;
  private readonly mcpClient: McpBiwengerClient;
  private readonly service: FocusService;
  private readonly gateway: BiwengerGateway;
  private readonly worker: FocusWorker;

  private constructor(api: OpenClawApiLike) {
    this.api = api;
    const rawConfig = this.resolveConfig(api);
    const config = loadConfig(rawConfig);

    this.logger = new Logger(config.logLevel);

    this.store = new SqliteStore(config.dbPath);
    const repo = new FocusRepository(this.store);

    this.mcpClient = new McpBiwengerClient({
      command: config.mcpCommand,
      args: config.mcpArgs,
      cwd: config.mcpCwd,
      env: process.env,
      logger: this.logger
    });

    this.gateway = new BiwengerGateway(this.mcpClient, this.logger);

    const notifiers: Notifier[] = [new LogNotifier(this.logger)];
    if (config.telegramBotToken && config.telegramChatId) {
      notifiers.push(new TelegramNotifier({
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId
      }));
    }

    const notifier = new CompositeNotifier(notifiers);
    this.service = new FocusService({
      repo,
      gateway: this.gateway,
      notifier,
      logger: this.logger,
      defaults: config.defaults
    });

    this.worker = new FocusWorker({
      service: this.service,
      gateway: this.gateway,
      logger: this.logger,
      lockTtlSec: config.lockTtlSec,
      missingTimeoutSec: config.missingTimeoutSec,
      tickSec: config.tickSec,
      maxConsecutiveErrors: config.maxConsecutiveErrors,
      biddingPollSec: config.biddingPollSec,
      armedMaxPollSec: config.armedMaxPollSec
    });
  }

  static async create(api: OpenClawApiLike): Promise<PluginRuntime> {
    const runtime = new PluginRuntime(api);
    await runtime.initialize();
    return runtime;
  }

  async stop(): Promise<void> {
    this.worker.stop();
    await this.mcpClient.close();
    this.store.close();
  }

  private async initialize(): Promise<void> {
    await this.store.init();
    await this.gateway.ping();

    await registerFocusTools(this.api, this.service, this.logger);

    if (this.api.registerService) {
      await this.api.registerService({
        id: 'biwenger-focus-worker',
        name: 'Biwenger Focus Worker',
        start: async () => {
          this.worker.start();
        },
        stop: async () => {
          this.worker.stop();
        }
      });
    }

    this.worker.start();

    this.logger.info('Biwenger focus plugin loaded', {
      action: 'plugin_loaded'
    });
  }

  private resolveConfig(api: OpenClawApiLike): OpenClawRuntimeConfig {
    if (typeof api.getConfig === 'function') {
      return api.getConfig() ?? {};
    }

    if (api.config && typeof api.config === 'object') {
      return api.config;
    }

    return {};
  }
}

let runtime: PluginRuntime | null = null;
let startupPromise: Promise<void> | null = null;
const PLUGIN_META = {
  id: 'biwenger-focus',
  name: 'Biwenger Focus',
  version: '0.1.11'
};

function reportStartupError(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error('[biwenger-focus] startup failed:', message);
}

async function startRuntime(api: OpenClawApiLike): Promise<void> {
  runtime = await PluginRuntime.create(api);
}

async function stopRuntime(): Promise<void> {
  if (!runtime) return;
  await runtime.stop();
  runtime = null;
}

function start(api: OpenClawApiLike): void {
  if (startupPromise) return;
  startupPromise = startRuntime(api)
    .catch((error) => {
      reportStartupError(error);
      runtime = null;
    })
    .finally(() => {
      startupPromise = null;
    });
}

export function register(api: OpenClawApiLike): () => void {
  start(api);
  return () => {
    void stopRuntime();
  };
}

export const activate = register;

export default {
  id: PLUGIN_META.id,
  name: PLUGIN_META.name,
  version: PLUGIN_META.version,
  register,
  activate
};
