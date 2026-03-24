export const ACTIVE_CLAUSE_STATUSES = ['PENDING', 'EXECUTING'] as const;
export const FINAL_CLAUSE_STATUSES = ['COMPLETED_EXECUTED', 'COMPLETED_SKIPPED_MAX', 'CANCELLED', 'FAILED'] as const;

export type ClauseStatus = (typeof ACTIVE_CLAUSE_STATUSES)[number] | (typeof FINAL_CLAUSE_STATUSES)[number];

export interface ClauseTask {
  id: string;
  playerQuery: string;
  playerId: number;
  playerName: string;
  competition: string | null;
  maxClauseAmount: number;
  scheduledAt: number;
  status: ClauseStatus;
  stopReason: string | null;
  createdAt: number;
  updatedAt: number;
  executedAt: number | null;
  nextRunAt: number;
  lockToken: string | null;
  lockExpiresAt: number | null;
}

export interface ClauseRuntime {
  clauseId: string;
  lastSeenClauseAmount: number | null;
  lastSeenOwnerUserId: number | null;
  executedAmount: number | null;
  consecutiveErrors: number;
  lastError: string | null;
}

export interface CreateClauseScheduleInput {
  playerQuery: string;
  maxClauseAmount?: number;
  executeAt: number;
  competition?: string;
}

export interface UpdateClauseScheduleInput {
  clauseId: string;
  maxClauseAmount?: number;
  executeAt?: number;
}

export interface ClauseStatusResult {
  task: ClauseTask;
  runtime: ClauseRuntime;
  secondsUntilExecution: number | null;
}
