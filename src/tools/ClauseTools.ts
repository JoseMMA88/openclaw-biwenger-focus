import type { ClauseStatus } from '../domain/clause.js';
import { ClauseError, ClauseService } from '../clause/ClauseService.js';
import { Logger } from '../logger.js';
import { nowSec } from '../utils/time.js';

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
  if (error instanceof ClauseError) {
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
    throw new ClauseError('VALIDATION_ERROR', `${field} debe ser entero positivo.`);
  }
  return parsed;
}

function toOptionalStatus(value: unknown): ClauseStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ClauseError('VALIDATION_ERROR', 'status debe ser string.');
  }

  const normalized = value.trim().toUpperCase();
  const allowed = new Set([
    'PENDING',
    'EXECUTING',
    'COMPLETED_EXECUTED',
    'COMPLETED_SKIPPED_MAX',
    'CANCELLED',
    'FAILED'
  ]);

  if (!allowed.has(normalized)) {
    throw new ClauseError('VALIDATION_ERROR', 'status no válido.');
  }

  return normalized as ClauseStatus;
}

function toExecuteAt(args: Record<string, unknown>): number {
  const executeAt = toOptionalPositiveInt(args.execute_at, 'execute_at');
  if (executeAt !== undefined) return executeAt;

  const executeAtIso = typeof args.execute_at_iso === 'string' ? args.execute_at_iso.trim() : '';
  if (!executeAtIso) {
    throw new ClauseError('VALIDATION_ERROR', 'Debes indicar execute_at (epoch) o execute_at_iso (ISO-8601).');
  }

  const millis = Date.parse(executeAtIso);
  if (!Number.isFinite(millis)) {
    throw new ClauseError('VALIDATION_ERROR', 'execute_at_iso no tiene formato válido (ISO-8601).');
  }

  const epochSec = Math.floor(millis / 1000);
  if (epochSec <= nowSec()) {
    throw new ClauseError('VALIDATION_ERROR', 'execute_at_iso debe estar en el futuro.');
  }

  return epochSec;
}

export async function registerClauseTools(api: OpenClawApiLike, service: ClauseService, logger: Logger): Promise<void> {
  if (!api.registerTool) {
    throw new Error('OpenClaw API missing registerTool()');
  }

  const tools: Array<Record<string, unknown>> = [
    {
      name: 'biwenger_clause_schedule_create',
      description: 'Programa un clausulazo para fecha/hora concreta con tope máximo de importe.',
      parameters: {
        type: 'object',
        properties: {
          player_query: { type: 'string' },
          max_clause_amount: { type: 'integer' },
          execute_at: { type: 'integer', description: 'Epoch seconds en UTC' },
          execute_at_iso: { type: 'string', description: 'Fecha ISO-8601 (ej. 2026-03-05T22:30:00+01:00)' },
          competition: { type: 'string' }
        },
        required: ['player_query', 'max_clause_amount'],
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          const result = await service.createSchedule({
            playerQuery: String(args.player_query ?? ''),
            maxClauseAmount: Number(args.max_clause_amount),
            executeAt: toExecuteAt(args),
            competition: typeof args.competition === 'string' ? args.competition : undefined
          });

          return success({
            clause_id: result.clauseId,
            player_id: result.playerId,
            resolved_player_name: result.resolvedPlayerName,
            status: result.status,
            scheduled_at: result.scheduledAt,
            scheduled_at_iso: new Date(result.scheduledAt * 1000).toISOString(),
            seconds_until_execution: result.secondsUntilExecution
          });
        } catch (error) {
          logger.warn('Tool biwenger_clause_schedule_create failed', {
            action: 'tool_failed',
            tool: 'biwenger_clause_schedule_create',
            error: error instanceof Error ? error.message : String(error)
          });
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_clause_schedule_status',
      description: 'Consulta estado de una cláusula programada por clause_id o player_query.',
      parameters: {
        type: 'object',
        properties: {
          clause_id: { type: 'string' },
          player_query: { type: 'string' }
        },
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          const result = service.getStatus({
            clauseId: typeof args.clause_id === 'string' ? args.clause_id : undefined,
            playerQuery: typeof args.player_query === 'string' ? args.player_query : undefined
          });

          return success({
            clause_id: result.task.id,
            player_id: result.task.playerId,
            player_name: result.task.playerName,
            status: result.task.status,
            stop_reason: result.task.stopReason,
            max_clause_amount: result.task.maxClauseAmount,
            scheduled_at: result.task.scheduledAt,
            scheduled_at_iso: new Date(result.task.scheduledAt * 1000).toISOString(),
            next_run_at: result.task.nextRunAt,
            next_run_at_iso: new Date(result.task.nextRunAt * 1000).toISOString(),
            seconds_until_execution: result.secondsUntilExecution,
            last_seen_clause_amount: result.runtime.lastSeenClauseAmount,
            last_seen_owner_user_id: result.runtime.lastSeenOwnerUserId,
            executed_amount: result.runtime.executedAmount,
            updated_at: result.task.updatedAt
          });
        } catch (error) {
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_clause_schedule_list',
      description: 'Lista clausulazos programados activos o finalizados.',
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
              clause_id: task.id,
              player_id: task.playerId,
              player_name: task.playerName,
              status: task.status,
              stop_reason: task.stopReason,
              max_clause_amount: task.maxClauseAmount,
              scheduled_at: task.scheduledAt,
              scheduled_at_iso: new Date(task.scheduledAt * 1000).toISOString(),
              next_run_at: task.nextRunAt,
              next_run_at_iso: new Date(task.nextRunAt * 1000).toISOString(),
              updated_at: task.updatedAt
            }))
          });
        } catch (error) {
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_clause_schedule_update',
      description: 'Actualiza un clausulazo programado (tope y/o fecha de ejecución).',
      parameters: {
        type: 'object',
        properties: {
          clause_id: { type: 'string' },
          max_clause_amount: { type: 'integer' },
          execute_at: { type: 'integer' },
          execute_at_iso: { type: 'string' }
        },
        required: ['clause_id'],
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          if (typeof args.clause_id !== 'string' || args.clause_id.trim().length === 0) {
            throw new ClauseError('VALIDATION_ERROR', 'clause_id es obligatorio.');
          }

          const hasExecuteAt = args.execute_at !== undefined || args.execute_at_iso !== undefined;
          const updated = service.updateSchedule({
            clauseId: args.clause_id,
            maxClauseAmount: toOptionalPositiveInt(args.max_clause_amount, 'max_clause_amount'),
            executeAt: hasExecuteAt ? toExecuteAt(args) : undefined
          });

          return success({
            clause_id: updated.id,
            status: updated.status,
            config: {
              max_clause_amount: updated.maxClauseAmount,
              scheduled_at: updated.scheduledAt,
              scheduled_at_iso: new Date(updated.scheduledAt * 1000).toISOString()
            },
            updated_at: updated.updatedAt
          });
        } catch (error) {
          return failure(error);
        }
      }
    },
    {
      name: 'biwenger_clause_schedule_cancel',
      description: 'Cancela una cláusula programada activa.',
      parameters: {
        type: 'object',
        properties: {
          clause_id: { type: 'string' }
        },
        required: ['clause_id'],
        additionalProperties: false
      },
      execute: async (_id: string, raw: unknown) => {
        try {
          const args = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
          if (typeof args.clause_id !== 'string' || args.clause_id.trim().length === 0) {
            throw new ClauseError('VALIDATION_ERROR', 'clause_id es obligatorio.');
          }

          const cancelled = await service.cancelSchedule(args.clause_id);

          return success({
            clause_id: cancelled.id,
            status: cancelled.status,
            stop_reason: cancelled.stopReason,
            executed_at: cancelled.executedAt
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
