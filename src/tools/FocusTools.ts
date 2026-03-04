import { FocusError, FocusService } from '../focus/FocusService.js';
import { Logger } from '../logger.js';
import type { FocusStatus } from '../domain/focus.js';

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
  if (error instanceof FocusError) {
    return toToolResult({
      ok: false,
      error_code: error.code,
      error: error.message,
      details: error.details ?? null
    });
  }

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

function toOptionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new FocusError('VALIDATION_ERROR', `${field} debe ser entero positivo.`);
  }
  return parsed;
}

function toOptionalStatus(value: unknown): FocusStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new FocusError('VALIDATION_ERROR', 'status debe ser string.');
  }

  const normalized = value.trim().toUpperCase();
  const allowed = new Set([
    'PENDING',
    'ARMED',
    'BIDDING',
    'COMPLETED_WON',
    'COMPLETED_LOST',
    'CANCELLED',
    'FAILED'
  ]);

  if (!allowed.has(normalized)) {
    throw new FocusError('VALIDATION_ERROR', 'status no válido.');
  }

  return normalized as FocusStatus;
}

export async function registerFocusTools(api: OpenClawApiLike, service: FocusService, logger: Logger): Promise<void> {
  if (!api.registerTool) {
    throw new Error('OpenClaw API missing registerTool()');
  }

  const tools: Array<Record<string, unknown>> = [
    {
      name: 'biwenger_focus_create',
      description: 'Crea un foco automático de subasta para un jugador de Biwenger.',
      parameters: {
        type: 'object',
        properties: {
          player_query: { type: 'string' },
          max_price: { type: 'integer' },
          start_when_remaining_sec: { type: 'integer' },
          bid_step: { type: 'integer' },
          poll_sec: { type: 'integer' },
          cooldown_sec: { type: 'integer' },
          competition: { type: 'string' }
        },
        required: ['player_query', 'max_price'],
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          const result = await service.createFocus({
            playerQuery: String(args.player_query ?? ''),
            maxPrice: Number(args.max_price),
            startWhenRemainingSec: toOptionalPositiveInt(args.start_when_remaining_sec, 'start_when_remaining_sec'),
            bidStep: toOptionalPositiveInt(args.bid_step, 'bid_step'),
            pollSec: toOptionalPositiveInt(args.poll_sec, 'poll_sec'),
            cooldownSec: toOptionalPositiveInt(args.cooldown_sec, 'cooldown_sec'),
            competition: typeof args.competition === 'string' ? args.competition : undefined
          });

          return success({
            focus_id: result.focusId,
            player_id: result.playerId,
            resolved_player_name: result.resolvedPlayerName,
            auction_until: result.auctionUntil,
            current_price: result.currentPrice,
            status: result.status
          });
        } catch (error) {
          logger.warn('Tool biwenger_focus_create failed', {
            action: 'tool_failed',
            tool: 'biwenger_focus_create',
            error: error instanceof Error ? error.message : String(error)
          });
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_focus_status',
      description: 'Consulta estado de un foco por focus_id o player_query.',
      parameters: {
        type: 'object',
        properties: {
          focus_id: { type: 'string' },
          player_query: { type: 'string' }
        },
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          const result = service.getStatus({
            focusId: typeof args.focus_id === 'string' ? args.focus_id : undefined,
            playerQuery: typeof args.player_query === 'string' ? args.player_query : undefined
          });

          return success({
            focus_id: result.task.id,
            player_id: result.task.playerId,
            player_name: result.task.playerName,
            status: result.task.status,
            stop_reason: result.task.stopReason,
            remaining_sec: result.remainingSec,
            last_seen_price: result.runtime.lastSeenPrice,
            last_bid_amount: result.runtime.lastBidAmount,
            next_bid_amount: result.nextBidAmount,
            next_poll_at: result.task.nextPollAt,
            updated_at: result.task.updatedAt
          });
        } catch (error) {
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_focus_list',
      description: 'Lista focos activos o finalizados.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'integer' }
        },
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          const status = toOptionalStatus(args.status);
          const limit = toOptionalPositiveInt(args.limit, 'limit') ?? 50;
          const tasks = service.list(status, limit);

          return success({
            total: tasks.length,
            items: tasks.map((task) => ({
              focus_id: task.id,
              player_id: task.playerId,
              player_name: task.playerName,
              status: task.status,
              stop_reason: task.stopReason,
              max_price: task.maxPrice,
              bid_step: task.bidStep,
              poll_sec: task.pollSec,
              cooldown_sec: task.cooldownSec,
              next_poll_at: task.nextPollAt,
              updated_at: task.updatedAt
            }))
          });
        } catch (error) {
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_focus_update',
      description: 'Actualiza configuración editable de un foco.',
      parameters: {
        type: 'object',
        properties: {
          focus_id: { type: 'string' },
          max_price: { type: 'integer' },
          start_when_remaining_sec: { type: 'integer' },
          bid_step: { type: 'integer' },
          poll_sec: { type: 'integer' },
          cooldown_sec: { type: 'integer' }
        },
        required: ['focus_id'],
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          if (typeof args.focus_id !== 'string' || args.focus_id.trim().length === 0) {
            throw new FocusError('VALIDATION_ERROR', 'focus_id es obligatorio.');
          }

          const updated = service.updateFocus({
            focusId: args.focus_id,
            maxPrice: toOptionalPositiveInt(args.max_price, 'max_price'),
            startWhenRemainingSec: toOptionalPositiveInt(args.start_when_remaining_sec, 'start_when_remaining_sec'),
            bidStep: toOptionalPositiveInt(args.bid_step, 'bid_step'),
            pollSec: toOptionalPositiveInt(args.poll_sec, 'poll_sec'),
            cooldownSec: toOptionalPositiveInt(args.cooldown_sec, 'cooldown_sec')
          });

          return success({
            focus_id: updated.id,
            status: updated.status,
            config: {
              max_price: updated.maxPrice,
              start_when_remaining_sec: updated.startWhenRemainingSec,
              bid_step: updated.bidStep,
              poll_sec: updated.pollSec,
              cooldown_sec: updated.cooldownSec
            },
            updated_at: updated.updatedAt
          });
        } catch (error) {
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_focus_cancel',
      description: 'Cancela un foco activo.',
      parameters: {
        type: 'object',
        properties: {
          focus_id: { type: 'string' }
        },
        required: ['focus_id'],
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          if (typeof args.focus_id !== 'string' || args.focus_id.trim().length === 0) {
            throw new FocusError('VALIDATION_ERROR', 'focus_id es obligatorio.');
          }

          const cancelled = await service.cancelFocus(args.focus_id);

          return success({
            focus_id: cancelled.id,
            status: cancelled.status,
            stop_reason: cancelled.stopReason,
            finished_at: cancelled.finishedAt
          });
        } catch (error) {
          return failure(error);
        }
      }
    }
  ];

  for (const tool of tools) {
    await api.registerTool(tool);
  }
}
