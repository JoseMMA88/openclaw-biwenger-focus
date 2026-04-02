import 'dotenv/config';

import { ClauseService } from './clause/ClauseService.js';
import { ClauseWorker } from './clause/ClauseWorker.js';
import { ClauseRepository } from './db/ClauseRepository.js';
import { loadConfig, type OpenClawRuntimeConfig } from './config.js';
import { FocusRepository } from './db/FocusRepository.js';
import { MarketRepository } from './db/MarketRepository.js';
import { SqliteStore } from './db/SqliteStore.js';
import { FocusService } from './focus/FocusService.js';
import { FocusWorker } from './focus/FocusWorker.js';
import { BiwengerGateway } from './gateway/BiwengerGateway.js';
import { Logger } from './logger.js';
import { MarketReportService } from './market/MarketReportService.js';
import { MarketReportWorker } from './market/MarketReportWorker.js';
import { McpBiwengerClient } from './mcp/McpBiwengerClient.js';
import { CompositeNotifier } from './notify/CompositeNotifier.js';
import { LogNotifier } from './notify/LogNotifier.js';
import type { Notifier } from './notify/Notifier.js';
import { TelegramNotifier } from './notify/TelegramNotifier.js';
import { registerClauseTools } from './tools/ClauseTools.js';
import { registerFocusTools } from './tools/FocusTools.js';
import { registerMarketTools } from './tools/MarketTools.js';

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
  private readonly clauseService: ClauseService;
  private readonly marketService: MarketReportService;
  private readonly gateway: BiwengerGateway;
  private readonly worker: FocusWorker;
  private readonly clauseWorker: ClauseWorker;
  private readonly marketWorker: MarketReportWorker;

  private constructor(api: OpenClawApiLike) {
    this.api = api;
    const rawConfig = this.resolveConfig(api);
    const config = loadConfig(rawConfig);

    this.logger = new Logger(config.logLevel);

    this.store = new SqliteStore(config.dbPath);
    const focusRepo = new FocusRepository(this.store);
    const clauseRepo = new ClauseRepository(this.store);
    const marketRepo = new MarketRepository(this.store);

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
      repo: focusRepo,
      gateway: this.gateway,
      notifier,
      logger: this.logger,
      defaults: config.defaults
    });
    this.clauseService = new ClauseService({
      repo: clauseRepo,
      gateway: this.gateway,
      notifier,
      logger: this.logger
    });
    this.marketService = new MarketReportService({
      repo: marketRepo,
      notifier,
      logger: this.logger,
      tz: config.tz,
      scheduleHour: config.marketReportHour,
      scheduleMinute: config.marketReportMinute,
      topLimit: config.marketReportTopLimit
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

    this.clauseWorker = new ClauseWorker({
      service: this.clauseService,
      gateway: this.gateway,
      logger: this.logger,
      lockTtlSec: config.lockTtlSec,
      tickSec: config.tickSec,
      maxConsecutiveErrors: config.maxConsecutiveErrors
    });
    this.marketWorker = new MarketReportWorker({
      service: this.marketService,
      gateway: this.gateway,
      logger: this.logger,
      tickSec: config.marketReportTickSec,
      enabled: config.marketReportEnabled,
      openingOnly: config.marketReportOpeningOnly
    });
  }

  static async create(api: OpenClawApiLike): Promise<PluginRuntime> {
    const runtime = new PluginRuntime(api);
    await runtime.initialize();
    return runtime;
  }

  async stop(): Promise<void> {
    this.worker.stop();
    this.clauseWorker.stop();
    this.marketWorker.stop();
    await this.mcpClient.close();
    this.store.close();
  }

  private async initialize(): Promise<void> {
    await this.store.init();
    await this.gateway.ping();

    await registerFocusTools(this.api, this.service, this.logger);
    await registerClauseTools(this.api, this.clauseService, this.logger);
    await registerMarketTools(this.api, this.marketService, this.marketWorker, this.logger);

    if (this.api.registerService) {
      await this.api.registerService({
        id: 'biwenger-focus-worker',
        name: 'Biwenger Focus Worker',
        start: async () => {
          this.worker.start();
          this.clauseWorker.start();
          this.marketWorker.start();
        },
        stop: async () => {
          this.worker.stop();
          this.clauseWorker.stop();
          this.marketWorker.stop();
        }
      });
    }

    this.worker.start();
    this.clauseWorker.start();
    this.marketWorker.start();

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
  version: '0.1.30'
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
