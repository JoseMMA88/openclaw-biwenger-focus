import { MarketReportService } from '../market/MarketReportService.js';
import { MarketReportWorker } from '../market/MarketReportWorker.js';
import { Logger } from '../logger.js';

interface OpenClawApiLike {
  registerTool?: (tool: Record<string, unknown>, options?: Record<string, unknown>) => void | Promise<void>;
}

function toToolResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload)
      }
    ],
    structuredContent: payload
  };
}

function success(payload: Record<string, unknown>): Record<string, unknown> {
  return toToolResult({ ok: true, ...payload });
}

function failure(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return toToolResult({
      ok: false,
      error_code: 'INTERNAL_ERROR',
      error: error.message,
      details: null
    });
  }

  return toToolResult({
    ok: false,
    error_code: 'INTERNAL_ERROR',
    error: 'Unknown error',
    details: null
  });
}

export async function registerMarketTools(
  api: OpenClawApiLike,
  service: MarketReportService,
  worker: MarketReportWorker,
  logger: Logger
): Promise<void> {
  if (!api.registerTool) {
    throw new Error('OpenClaw API missing registerTool()');
  }

  const tools: Array<Record<string, unknown>> = [
    {
      name: 'biwenger_market_report_status',
      description: 'Devuelve estado del informe diario de mercado (último envío y si está pendiente hoy).',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      execute: async () => {
        try {
          const status = service.getStatus();
          return success({
            now_date: status.nowDate,
            schedule_hour: status.scheduleHour,
            schedule_minute: status.scheduleMinute,
            due_now: status.dueNow,
            last_report_date: status.lastReportDate,
            last_report_at: status.lastReportAt
          });
        } catch (error) {
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_market_report_now',
      description: 'Lanza inmediatamente el informe diario de mercado (si no se envió hoy).',
      parameters: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'No implementado: reservado para futuras versiones.' }
        },
        additionalProperties: false
      },
      execute: async () => {
        try {
          const emitted = await worker.runReportNow();
          const status = service.getStatus();

          return success({
            emitted,
            now_date: status.nowDate,
            last_report_date: status.lastReportDate,
            last_report_at: status.lastReportAt
          });
        } catch (error) {
          logger.warn('Tool biwenger_market_report_now failed', {
            action: 'tool_failed',
            tool: 'biwenger_market_report_now',
            error: error instanceof Error ? error.message : String(error)
          });
          return failure(error);
        }
      }
    }
  ];

  for (const tool of tools) {
    await api.registerTool(tool);
  }
}
