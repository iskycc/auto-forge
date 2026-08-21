import type {
  AttemptRecoveryReason,
  ClaimedAssignmentRecord,
  ExecutionControlRepository,
  RecoveredAttemptExpiration,
} from "@autoforge/application";
import {
  attemptEventPageSchema,
  completeAttemptResponseSchema,
  executionSpecSchema,
  reconcileAttemptsResponseSchema,
  type ArtifactDeclaration,
  type AssignmentDto,
  type CompleteAttemptResponse,
  type CompletionResult,
  type ReconcileAttemptsResponse,
} from "@autoforge/contracts";
import {
  aggregateBatchStatus,
  DomainError,
  isTerminalAttemptStatus,
  isTerminalBatchStatus,
  isTerminalRunStatus,
  isRetryableRunnerFailure,
  outcomeAfterCompletion,
  transitionAssignment,
  transitionExecutionRun,
  transitionLease,
  transitionRunBatch,
  transitionRunAttempt,
  type AssignmentStatus,
  type ExecutionRunStatus,
  type RunAttemptStatus,
  type RunBatchStatus,
} from "@autoforge/domain";
import type { PoolClient } from "pg";

import type { AttemptLogStore } from "./attempt-log-store";
import type { PostgresDatabaseHandle } from "./postgres-database";
import { QUERY_IN_CHUNK_SIZE, splitIntoChunks } from "./query-chunks";

type AssignmentRow = {
  id: string;
  attempt_id: string;
  execution_run_id: string;
  batch_id: string;
  runner_id: string;
  status: AssignmentStatus;
  priority: number;
  execution_spec_json: string;
  available_at: string;
  claim_deadline_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  cancel_requested_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type LeaseRow = {
  id: string;
  assignment_id: string;
  runner_id: string;
  token_hash: string;
  token_encrypted: string;
  status: "active" | "released" | "expired" | "revoked";
  version: number;
  expires_at: string;
  renewed_at: string;
  created_at: string;
};

type AttemptControlRow = {
  id: string;
  execution_run_id: string;
  runner_id: string;
  attempt_number: number;
  status: RunAttemptStatus;
  run_status: ExecutionRunStatus;
  retry_limit: number;
  retry_mode: "immediate" | "round";
  batch_id: string;
  project_id: string;
  run_cancel_requested_at: string | null;
  batch_termination_requested_at: string | null;
};

type ArtifactRow = {
  id: string;
  attempt_id: string;
  relative_path: string;
  object_key: string | null;
  media_type: string;
  size_bytes: string;
  sha256: string;
  required: boolean;
  status: "declared" | "uploaded" | "rejected";
};

type AttemptEventRow = {
  id: string;
  attempt_id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  reason_code: string | null;
  actor_type: "user" | "runner" | "system";
  actor_id: string | null;
  details_json: string;
  recorded_at: string;
};

export class PostgresExecutionControlRepository implements ExecutionControlRepository {
  private readonly recordedAttemptLogPaths = new Set<string>();

  constructor(
    private readonly handle: PostgresDatabaseHandle,
    private readonly attemptLogs: AttemptLogStore,
  ) {}

  async claim(
    input: Parameters<ExecutionControlRepository["claim"]>[0],
  ): Promise<ClaimedAssignmentRecord[]> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const replay = await this.claimReplay(client, input.runnerId, input.requestId);
      if (replay) return replay;
      if (input.availableSlots === 0) return [];
      const candidateResult = await client.query<AssignmentRow>(
        `SELECT a.* FROM assignments a
         JOIN run_batches b ON b.id = a.batch_id
         WHERE a.runner_id = $1 AND a.status = 'pending' AND a.available_at <= $2
           AND a.claim_deadline_at > $2 AND b.cancel_requested_at IS NULL
         ORDER BY a.priority DESC, a.created_at ASC, a.id ASC
         FOR UPDATE OF a SKIP LOCKED LIMIT $3`,
        [input.runnerId, input.now, Math.max(input.availableSlots * 8, 8)],
      );
      const selected = candidateResult.rows
        .filter((assignment) =>
          matchesAgent(parseSpec(assignment), input.labels, input.capabilities),
        )
        .slice(0, input.availableSlots);
      const claimed: ClaimedAssignmentRecord[] = [];
      const claimedBatchEvents = new Map<string, string>();
      for (const [index, assignment] of selected.entries()) {
        const seed = input.leaseSeeds[index];
        if (!seed) break;
        const update = await client.query(
          `UPDATE assignments SET status = 'claimed', claimed_at = $1, updated_at = $1, version = version + 1
           WHERE id = $2 AND status = 'pending'
             AND EXISTS (SELECT 1 FROM run_batches b
                         WHERE b.id = assignments.batch_id AND b.cancel_requested_at IS NULL)`,
          [input.now, assignment.id],
        );
        if (update.rowCount !== 1) continue;
        await client.query(
          `INSERT INTO assignment_leases
           (id, assignment_id, runner_id, token_hash, token_encrypted, status, version, expires_at, renewed_at, created_at)
           VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $7, $7)`,
          [
            seed.id,
            assignment.id,
            input.runnerId,
            seed.tokenHash,
            seed.tokenEncrypted,
            input.leaseExpiresAt,
            input.now,
          ],
        );
        await client.query(
          `UPDATE run_attempts SET status = 'running', started_at = COALESCE(started_at, $1), version = version + 1
           WHERE id = $2 AND status = 'assigned'`,
          [input.now, assignment.attempt_id],
        );
        await client.query(
          `UPDATE execution_runs SET status = 'running', version = version + 1, updated_at = $1
           WHERE id = $2 AND status = 'assigned'`,
          [input.now, assignment.execution_run_id],
        );
        await appendAttemptEvent(client, {
          id: seed.eventId,
          attemptId: assignment.attempt_id,
          eventType: "assignment.claimed",
          fromStatus: "assigned",
          toStatus: "running",
          actorType: "runner",
          actorId: input.runnerId,
          details: {
            assignmentId: assignment.id,
            leaseId: seed.id,
            leaseExpiresAt: input.leaseExpiresAt,
          },
          recordedAt: input.now,
        });
        if (!claimedBatchEvents.has(assignment.batch_id)) {
          claimedBatchEvents.set(assignment.batch_id, seed.eventId);
        }
        claimed.push({
          assignment: mapAssignment({
            ...assignment,
            status: "claimed",
            claimed_at: input.now,
            updated_at: input.now,
            version: assignment.version + 1,
          }),
          lease: {
            id: seed.id,
            tokenEncrypted: seed.tokenEncrypted,
            version: 1,
            expiresAt: input.leaseExpiresAt,
          },
        });
      }
      for (const [batchId, eventId] of claimedBatchEvents) {
        await updateBatchStatus(client, batchId, input.now, eventId, "assignment.claimed");
      }
      if (claimed.length > 0) {
        await this.saveClaimRequest(
          client,
          input.runnerId,
          input.requestId,
          claimed.map((entry) => ({
            assignmentId: entry.assignment.assignmentId,
            leaseId: entry.lease.id,
          })),
          input.now,
        );
      }
      return claimed;
    });
  }

  async renewLease(
    input: Parameters<ExecutionControlRepository["renewLease"]>[0],
  ): ReturnType<ExecutionControlRepository["renewLease"]> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const lease = await requiredLease(client, input.leaseId, true);
      if (lease.runner_id !== input.runnerId || lease.token_hash !== input.tokenHash) {
        throw new DomainError("LEASE_AUTH_REJECTED", "租约凭据无效。");
      }
      if (lease.status !== "active" || lease.expires_at <= input.now) {
        throw new DomainError("LEASE_EXPIRED", "租约已过期或失效。");
      }
      if (lease.version !== input.expectedVersion) {
        throw new DomainError("LEASE_VERSION_CONFLICT", "租约版本已变化。");
      }
      const assignment = await requiredAssignment(client, lease.assignment_id);
      const instruction = assignment.cancel_requested_at
        ? ("cancel" as const)
        : ("continue" as const);
      const nextVersion = lease.version + 1;
      await client.query(
        `UPDATE assignment_leases SET version = $1, expires_at = $2, renewed_at = $3
         WHERE id = $4 AND status = 'active' AND version = $5`,
        [nextVersion, input.expiresAt, input.now, input.leaseId, input.expectedVersion],
      );
      await client.query(
        `UPDATE assignments SET status = CASE WHEN status = 'claimed' THEN 'running' ELSE status END,
         updated_at = $1, version = version + 1 WHERE id = $2 AND status IN ('claimed', 'running')`,
        [input.now, assignment.id],
      );
      return {
        schemaVersion: 1 as const,
        acceptedAt: input.now,
        leaseVersion: nextVersion,
        expiresAt: input.expiresAt,
        instruction,
      };
    });
  }

  async completeAttempt(
    input: Parameters<ExecutionControlRepository["completeAttempt"]>[0],
  ): Promise<CompleteAttemptResponse> {
    await this.handle.ready;
    const result = await this.transaction(
      async (client): Promise<{ response: CompleteAttemptResponse } | { conflict: true }> => {
        const control = await requiredAttemptControl(client, input.attemptId, true);
        const assignment = await assignmentForAttempt(client, input.attemptId);
        const lease = assignment
          ? await latestLeaseForAssignment(client, assignment.id)
          : undefined;
        if (
          !assignment ||
          !lease ||
          lease.runner_id !== input.runnerId ||
          lease.token_hash !== input.leaseTokenHash
        ) {
          throw new DomainError("LEASE_AUTH_REJECTED", "完成上报的租约凭据无效。");
        }
        const existing = await client.query<{ result_digest: string; response_json: string }>(
          "SELECT result_digest, response_json FROM attempt_completion_receipts WHERE attempt_id = $1 FOR UPDATE",
          [input.attemptId],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].result_digest !== input.resultDigest) {
            await appendAttemptEvent(client, {
              id: input.eventId,
              attemptId: input.attemptId,
              eventType: "attempt.completion_conflict",
              fromStatus: control.status,
              toStatus: control.status,
              reasonCode: "ATTEMPT_COMPLETION_CONFLICT",
              actorType: "runner",
              actorId: input.runnerId,
              details: {
                completionId: input.completionId,
                receivedDigest: input.resultDigest,
                storedDigest: existing.rows[0].result_digest,
              },
              recordedAt: input.acceptedAt,
            });
            return { conflict: true };
          }
          return {
            response: {
              ...completeAttemptResponseSchema.parse(JSON.parse(existing.rows[0].response_json)),
              disposition: "duplicate" as const,
            },
          };
        }
        const current = await client.query<{ value: number }>(
          "SELECT MAX(attempt_number)::integer AS value FROM run_attempts WHERE execution_run_id = $1",
          [control.execution_run_id],
        );
        const isLate =
          lease.status !== "active" ||
          lease.expires_at <= input.acceptedAt ||
          current.rows[0]?.value !== control.attempt_number ||
          isTerminalRunStatus(control.run_status);
        const response: CompleteAttemptResponse = {
          schemaVersion: 1 as const,
          completionId: input.completionId,
          acceptedAt: input.acceptedAt,
          disposition: isLate ? "late" : "accepted",
          retryScheduled: false,
          batchId: control.batch_id,
          batchClosed: await batchClosed(client, control.batch_id),
        };
        if (!isLate) {
          const effectiveResult = cancellationResult(input.result, control.run_cancel_requested_at);
          const failureCounts = await executionFailureCounts(client, control.execution_run_id);
          const decision = outcomeAfterCompletion({
            outcome: effectiveResult.status,
            attemptNumber: control.attempt_number,
            retryLimit: control.retry_limit,
            cancellationRequested: control.run_cancel_requested_at !== null,
            retryableRunnerFailure: isRetryableRunnerFailure(effectiveResult.resultCode),
            runnerFailuresBefore: failureCounts.runner,
            ordinaryFailuresBefore: failureCounts.ordinary,
            retrySuppressed: control.batch_termination_requested_at !== null,
          });
          response.retryScheduled = decision.retryScheduled;
          // persistCompletion 内部已聚合批次状态，直接用其返回值判定终态。
          response.batchClosed = isTerminalBatchStatus(
            await persistCompletion(
              client,
              this.attemptLogs,
              control,
              assignment,
              lease,
              effectiveResult,
              input,
              decision.runStatus,
            ),
          );
        }
        await client.query(
          `INSERT INTO attempt_completion_receipts
         (attempt_id, completion_id, result_digest, response_json, accepted_at) VALUES ($1, $2, $3, $4, $5)`,
          [
            input.attemptId,
            input.completionId,
            input.resultDigest,
            JSON.stringify(response),
            input.acceptedAt,
          ],
        );
        return { response };
      },
    );
    if ("conflict" in result) {
      throw new DomainError("ATTEMPT_COMPLETION_CONFLICT", "该执行尝试已收到不同的完成结果。");
    }
    return result.response;
  }

  async reconcile(
    input: Parameters<ExecutionControlRepository["reconcile"]>[0],
  ): Promise<ReconcileAttemptsResponse> {
    await this.handle.ready;
    const client = await this.handle.pool.connect();
    try {
      const decisions = [];
      for (const local of input.request.attempts) {
        const control = await findAttemptControl(client, local.attemptId);
        if (!control || control.runner_id !== input.runnerId) {
          decisions.push({ attemptId: local.attemptId, action: "clean" as const });
          continue;
        }
        if (isTerminalRunStatus(control.run_status) || isTerminalAttemptStatus(control.status)) {
          decisions.push({ attemptId: local.attemptId, action: "clean" as const });
          continue;
        }
        const assignment = await assignmentForAttempt(client, local.attemptId);
        const lease = assignment
          ? await latestLeaseForAssignment(client, assignment.id)
          : undefined;
        const action =
          assignment?.cancel_requested_at || control.run_cancel_requested_at
            ? "cancel"
            : lease && lease.status === "active" && lease.expires_at > input.now
              ? "continue"
              : "cancel";
        decisions.push({
          attemptId: local.attemptId,
          action,
          acknowledgedLogSequence: this.logWatermarks(control.batch_id, local.attemptId),
        });
      }
      return reconcileAttemptsResponseSchema.parse({ schemaVersion: 1, decisions });
    } finally {
      client.release();
    }
  }

  async resolveAttemptInput(
    input: Parameters<ExecutionControlRepository["resolveAttemptInput"]>[0],
  ): ReturnType<ExecutionControlRepository["resolveAttemptInput"]> {
    await this.handle.ready;
    let context: Awaited<ReturnType<typeof authorizedTransferContext>>;
    try {
      context = await authorizedTransferContext(this.handle.pool, input);
    } catch (error) {
      if (error instanceof DomainError && error.code === "ATTEMPT_TRANSFER_FORBIDDEN") {
        throw new DomainError("ATTEMPT_INPUT_FORBIDDEN", "输入不存在或任务租约无效。", {
          cause: error,
        });
      }
      throw error;
    }
    const declaredInput = parseSpec(context.assignment).inputs.find(
      (candidate) => candidate.inputId === input.inputId,
    );
    if (!declaredInput) {
      throw new DomainError("ATTEMPT_INPUT_FORBIDDEN", "输入未在执行快照中声明。");
    }
    let result = await this.handle.pool.query<{
      object_key: string;
      size_bytes: string | number;
      sha256: string;
    }>(
      `SELECT object_key, size_bytes, sha256
       FROM case_sources
       WHERE id = $1`,
      [input.inputId],
    );
    if (result.rowCount === 0 && !declaredInput.downloadUrl) {
      result = await this.handle.pool.query<{
        object_key: string;
        size_bytes: string | number;
        sha256: string;
      }>(
        `SELECT object_key, size_bytes, sha256
         FROM project_runtime_assets
         WHERE id = $1 AND source_type = 'upload' AND object_key IS NOT NULL`,
        [input.inputId],
      );
    }
    const row = result.rows[0];
    if (
      !row ||
      Number(row.size_bytes) !== declaredInput.sizeBytes ||
      row.sha256 !== declaredInput.sha256
    ) {
      throw new DomainError("ATTEMPT_INPUT_INVALID", "执行输入与权威对象元数据不一致。");
    }
    return { objectKey: row.object_key, sizeBytes: Number(row.size_bytes), sha256: row.sha256 };
  }

  async appendLogChunks(
    input: Parameters<ExecutionControlRepository["appendLogChunks"]>[0],
  ): ReturnType<ExecutionControlRepository["appendLogChunks"]> {
    await this.handle.ready;
    await authorizedTransferContext(this.handle.pool, { ...input, now: input.receivedAt });
    const batchId = await this.requiredBatchIdForAttempt(input.attemptId);
    // 日志内容写入每批次独立 SQLite 文件；PG 主库不再保存日志行。
    const acknowledgedSequence = await this.attemptLogs.appendChunks({
      batchId,
      attemptId: input.attemptId,
      receivedAt: input.receivedAt,
      chunks: input.chunks,
    });
    await this.recordAttemptLogsPath(batchId);
    return {
      schemaVersion: 1 as const,
      acknowledgedSequence,
    };
  }

  async listLogChunks(
    input: Parameters<ExecutionControlRepository["listLogChunks"]>[0],
  ): ReturnType<ExecutionControlRepository["listLogChunks"]> {
    await this.handle.ready;
    const attempt = await this.handle.pool.query<{ result_code: string | null }>(
      "SELECT result_code FROM run_attempts WHERE id = $1",
      [input.attemptId],
    );
    if (!attempt.rows[0]) {
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    }
    const batchId = await this.requiredBatchIdForAttempt(input.attemptId);
    const page = this.attemptLogs.listChunks({
      batchId,
      attemptId: input.attemptId,
      stream: input.stream,
      afterSequence: input.afterSequence,
      limit: input.limit,
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.recordedAfter !== undefined ? { recordedAfter: input.recordedAfter } : {}),
      ...(input.recordedBefore !== undefined ? { recordedBefore: input.recordedBefore } : {}),
    });
    return {
      items: page.items,
      acknowledgedSequence: this.attemptLogs.acknowledgedSequence(
        batchId,
        input.attemptId,
        input.stream,
      ),
      ...(page.hasMore && page.items.length > 0
        ? { nextSequence: page.items.at(-1)?.sequence ?? input.afterSequence }
        : {}),
      truncated: attempt.rows[0].result_code === "LOG_LIMIT_EXCEEDED",
    };
  }

  private async requiredBatchIdForAttempt(attemptId: string): Promise<string> {
    const result = await this.handle.pool.query<{ batch_id: string }>(
      `SELECT r.batch_id FROM run_attempts a
       JOIN execution_runs r ON r.id = a.execution_run_id WHERE a.id = $1`,
      [attemptId],
    );
    if (!result.rows[0]) {
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    }
    return result.rows[0].batch_id;
  }

  private async recordAttemptLogsPath(batchId: string): Promise<void> {
    if (this.recordedAttemptLogPaths.has(batchId)) return;
    // 主库只保存批次日志文件相对数据目录的路径；日志内容在独立 SQLite 文件中。
    const path = this.attemptLogs.relativeStorePath(batchId);
    await this.handle.pool.query(
      `UPDATE run_batches SET attempt_logs_path = $1
       WHERE id = $2 AND (attempt_logs_path IS NULL OR attempt_logs_path <> $1)`,
      [path, batchId],
    );
    rememberBounded(this.recordedAttemptLogPaths, batchId);
  }

  // reconcile 场景下水位来自批次日志文件；attempt 批次关联在 findAttemptControl 已解析。
  private logWatermarks(
    batchId: string,
    attemptId: string,
  ): { stdout: number; stderr: number; agent: number } {
    return {
      stdout: this.attemptLogs.acknowledgedSequence(batchId, attemptId, "stdout"),
      stderr: this.attemptLogs.acknowledgedSequence(batchId, attemptId, "stderr"),
      agent: this.attemptLogs.acknowledgedSequence(batchId, attemptId, "agent"),
    };
  }

  async resolveAttemptProjectId(attemptId: string): Promise<string | null> {
    await this.handle.ready;
    const result = await this.handle.pool.query<{ project_id: string }>(
      `SELECT b.project_id FROM run_attempts a
       JOIN execution_runs r ON r.id = a.execution_run_id
       JOIN run_batches b ON b.id = r.batch_id
       WHERE a.id = $1`,
      [attemptId],
    );
    return result.rows[0]?.project_id ?? null;
  }

  async resolveAttemptSchedulingContext(
    attemptId: string,
  ): ReturnType<ExecutionControlRepository["resolveAttemptSchedulingContext"]> {
    const row = (await this.resolveAttemptSchedulingContexts([attemptId]))[0];
    if (!row) return null;
    return {
      batchId: row.batchId,
      executionRunId: row.executionRunId,
      runnerId: row.runnerId,
      attemptNumber: row.attemptNumber,
      displayName: row.displayName,
      ...(row.heldRound !== undefined ? { heldRound: row.heldRound } : {}),
    };
  }

  async resolveAttemptSchedulingContexts(attemptIds: readonly string[]): Promise<
    Array<
      NonNullable<
        Awaited<ReturnType<ExecutionControlRepository["resolveAttemptSchedulingContext"]>>
      > & {
        attemptId: string;
      }
    >
  > {
    if (attemptIds.length === 0) return [];
    await this.handle.ready;
    const contexts = [];
    for (const chunk of splitIntoChunks(attemptIds, QUERY_IN_CHUNK_SIZE)) {
      const result = await this.handle.pool.query<{
        attempt_id: string;
        batch_id: string;
        execution_run_id: string;
        runner_id: string;
        attempt_number: number;
        display_name: string;
        held_round: number;
      }>(
        `SELECT a.id AS attempt_id, r.batch_id, a.execution_run_id, a.runner_id,
                a.attempt_number, r.display_name, r.held_round
         FROM run_attempts a
         JOIN execution_runs r ON r.id = a.execution_run_id
         WHERE a.id = ANY($1::text[])`,
        [chunk],
      );
      contexts.push(
        ...result.rows.map((row) => ({
          attemptId: row.attempt_id,
          batchId: row.batch_id,
          executionRunId: row.execution_run_id,
          runnerId: row.runner_id,
          attemptNumber: row.attempt_number,
          displayName: row.display_name,
          ...(row.held_round > 0 ? { heldRound: row.held_round } : {}),
        })),
      );
    }
    return contexts;
  }

  async countExistingAttemptIds(attemptIds: readonly string[]): Promise<number> {
    if (attemptIds.length === 0) return 0;
    await this.handle.ready;
    let total = 0;
    for (const chunk of splitIntoChunks(attemptIds, QUERY_IN_CHUNK_SIZE)) {
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
      const result = await this.handle.pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM run_attempts WHERE id IN (${placeholders})`,
        chunk,
      );
      total += Number(result.rows[0]?.count ?? 0);
    }
    return total;
  }

  async resolveExecutionRunProjectId(runId: string): Promise<string | null> {
    await this.handle.ready;
    const result = await this.handle.pool.query<{ project_id: string }>(
      `SELECT b.project_id FROM execution_runs r
       JOIN run_batches b ON b.id = r.batch_id WHERE r.id = $1`,
      [runId],
    );
    return result.rows[0]?.project_id ?? null;
  }

  async listAttemptEvents(
    input: Parameters<ExecutionControlRepository["listAttemptEvents"]>[0],
  ): ReturnType<ExecutionControlRepository["listAttemptEvents"]> {
    await this.handle.ready;
    const attempt = await this.handle.pool.query("SELECT id FROM run_attempts WHERE id = $1", [
      input.attemptId,
    ]);
    if (!attempt.rows[0]) {
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    }
    let cursor: { recorded_at: string; id: string } | undefined;
    if (input.afterEventId) {
      const cursorResult = await this.handle.pool.query<{ recorded_at: string; id: string }>(
        `SELECT recorded_at, id FROM attempt_state_events
         WHERE attempt_id = $1 AND id = $2`,
        [input.attemptId, input.afterEventId],
      );
      cursor = cursorResult.rows[0];
      if (!cursor) throw new DomainError("ATTEMPT_EVENT_CURSOR_INVALID", "执行事件游标无效。");
    }
    const parameters: Array<string | number> = [input.attemptId];
    const cursorClause = cursor ? "AND (recorded_at > $2 OR (recorded_at = $2 AND id > $3))" : "";
    if (cursor) parameters.push(cursor.recorded_at, cursor.id);
    parameters.push(input.limit + 1);
    const result = await this.handle.pool.query<AttemptEventRow>(
      `SELECT * FROM attempt_state_events WHERE attempt_id = $1 ${cursorClause}
       ORDER BY recorded_at, id LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = result.rows.length > input.limit;
    const page = result.rows.slice(0, input.limit);
    return attemptEventPageSchema.parse({
      items: page.map(mapAttemptEvent),
      ...(hasMore && page.at(-1) ? { nextEventId: page.at(-1)?.id } : {}),
    });
  }

  async declareArtifacts(
    input: Parameters<ExecutionControlRepository["declareArtifacts"]>[0],
  ): ReturnType<ExecutionControlRepository["declareArtifacts"]> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      await authorizedTransferContext(client, { ...input, now: input.declaredAt }, true);
      await client.query(
        `UPDATE run_attempts
         SET upload_started_at = COALESCE(upload_started_at, $1), version = version + 1
         WHERE id = $2 AND status = 'running'`,
        [input.declaredAt, input.attemptId],
      );
      const declared = [];
      for (const artifact of input.artifacts) {
        const existing = await artifactRow(client, input.attemptId, artifact.artifactId);
        if (existing) {
          if (!sameArtifact(existing, artifact) || existing.status === "rejected") {
            throw new DomainError("ARTIFACT_DECLARATION_CONFLICT", "产物声明与已保存元数据冲突。");
          }
          declared.push({ ...artifact, status: existing.status });
          continue;
        }
        await client.query(
          `INSERT INTO attempt_artifacts
           (id, attempt_id, relative_path, media_type, size_bytes, sha256, required, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'declared', $8, $8)`,
          [
            artifact.artifactId,
            input.attemptId,
            artifact.relativePath,
            artifact.mediaType,
            artifact.sizeBytes,
            artifact.sha256,
            artifact.required,
            input.declaredAt,
          ],
        );
        declared.push({ ...artifact, status: "declared" as const });
      }
      return declared;
    });
  }

  async resolveArtifactUpload(
    input: Parameters<ExecutionControlRepository["resolveArtifactUpload"]>[0],
  ): ReturnType<ExecutionControlRepository["resolveArtifactUpload"]> {
    await this.handle.ready;
    await authorizedTransferContext(this.handle.pool, input);
    const row = await artifactRow(this.handle.pool, input.attemptId, input.artifactId);
    if (!row) throw new DomainError("ARTIFACT_NOT_FOUND", "指定的产物声明不存在。");
    if (row.status === "rejected") {
      throw new DomainError("ARTIFACT_REJECTED", "指定的产物声明已被拒绝。");
    }
    return { ...mapArtifactRow(row), status: row.status };
  }

  async markArtifactUploaded(
    input: Parameters<ExecutionControlRepository["markArtifactUploaded"]>[0],
  ): Promise<void> {
    await this.handle.ready;
    const result = await this.handle.pool.query(
      `UPDATE attempt_artifacts SET object_key = $1, status = 'uploaded', updated_at = $2
       WHERE id = $3 AND attempt_id = $4 AND status IN ('declared', 'uploaded')`,
      [input.objectKey, input.uploadedAt, input.artifactId, input.attemptId],
    );
    if (result.rowCount !== 1)
      throw new DomainError("ARTIFACT_NOT_FOUND", "指定的产物声明不存在。");
  }

  async listArtifacts(attemptId: string): ReturnType<ExecutionControlRepository["listArtifacts"]> {
    await this.handle.ready;
    const attempt = await this.handle.pool.query("SELECT id FROM run_attempts WHERE id = $1", [
      attemptId,
    ]);
    if (!attempt.rows[0]) {
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    }
    const result = await this.handle.pool.query<ArtifactRow>(
      "SELECT * FROM attempt_artifacts WHERE attempt_id = $1 ORDER BY relative_path, id",
      [attemptId],
    );
    return result.rows.map(mapArtifactRow);
  }

  async recoverExpired(
    input: Parameters<ExecutionControlRepository["recoverExpired"]>[0],
  ): Promise<RecoveredAttemptExpiration[]> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const queued = await client.query<{ id: string; batch_id: string }>(
        `SELECT r.id, r.batch_id FROM execution_runs r
         JOIN run_batches b ON b.id = r.batch_id
         WHERE r.status = 'queued' AND r.queue_deadline_at IS NOT NULL
           AND r.queue_deadline_at::timestamptz <= $1::timestamptz
           AND b.status IN ('queued','dispatching','scheduled','running')
         ORDER BY r.queue_deadline_at::timestamptz, r.id
         LIMIT $2 FOR UPDATE OF r SKIP LOCKED`,
        [input.now, input.limit],
      );
      let recovered = 0;
      for (const run of queued.rows) {
        const eventId = input.eventIds[recovered];
        if (!eventId) break;
        const update = await client.query(
          `UPDATE execution_runs SET status = 'failed', terminal_outcome = 'timed_out',
           terminal_reason_code = 'QUEUE_TIMEOUT', updated_at = $1, version = version + 1
           WHERE id = $2 AND status = 'queued'
             AND queue_deadline_at::timestamptz <= $1::timestamptz
             AND EXISTS (
               SELECT 1 FROM run_batches b
               WHERE b.id = execution_runs.batch_id
                 AND b.status IN ('queued','dispatching','scheduled','running')
             )`,
          [input.now, run.id],
        );
        if (update.rowCount !== 1) continue;
        await updateBatchStatus(client, run.batch_id, input.now, eventId, "run.queue_timed_out");
        recovered += 1;
      }
      const active = await client.query<{
        lease_id: string;
        assignment_id: string;
        attempt_id: string;
        expiration_reason: AttemptRecoveryReason;
      }>(
        `SELECT l.id AS lease_id, a.id AS assignment_id, a.attempt_id,
           CASE WHEN ra.upload_started_at IS NOT NULL
             AND ra.upload_started_at::timestamptz + r.upload_timeout_ms * interval '1 millisecond' <= $1::timestamptz
             THEN 'upload_timeout'
           WHEN ra.upload_started_at IS NULL AND ra.started_at IS NOT NULL
             AND ra.started_at::timestamptz + r.execution_timeout_ms * interval '1 millisecond' <= $1::timestamptz
             THEN 'execution_timeout' ELSE 'lease_expired' END AS expiration_reason
         FROM assignment_leases l
         JOIN assignments a ON a.id = l.assignment_id
         JOIN run_attempts ra ON ra.id = a.attempt_id
         JOIN execution_runs r ON r.id = a.execution_run_id
         JOIN run_batches b ON b.id = r.batch_id
         WHERE l.status = 'active'
           AND a.status IN ('claimed','running')
           AND ra.status IN ('assigned','running')
           AND r.status IN ('assigned','running')
           AND b.status IN ('queued','dispatching','scheduled','running')
           AND (
           l.expires_at::timestamptz <= $1::timestamptz OR (
             ra.upload_started_at IS NOT NULL
             AND ra.upload_started_at::timestamptz + r.upload_timeout_ms * interval '1 millisecond' <= $1::timestamptz
           ) OR (
             ra.upload_started_at IS NULL AND ra.started_at IS NOT NULL
             AND ra.started_at::timestamptz + r.execution_timeout_ms * interval '1 millisecond' <= $1::timestamptz
           )
         )
         ORDER BY LEAST(
           l.expires_at::timestamptz,
           COALESCE(
             ra.upload_started_at::timestamptz + r.upload_timeout_ms * interval '1 millisecond',
             ra.started_at::timestamptz + r.execution_timeout_ms * interval '1 millisecond'
           )
         )
         LIMIT $2 FOR UPDATE OF l SKIP LOCKED`,
        [input.now, Math.max(0, input.limit - recovered)],
      );
      const remaining = Math.max(0, input.limit - recovered - active.rows.length);
      const unclaimed = await client.query<{
        assignment_id: string;
        attempt_id: string;
        expiration_reason: AttemptRecoveryReason;
      }>(
        `SELECT a.id AS assignment_id, a.attempt_id, 'claim_timeout' AS expiration_reason
         FROM assignments a
         JOIN run_attempts ra ON ra.id = a.attempt_id
         JOIN execution_runs r ON r.id = a.execution_run_id
         JOIN run_batches b ON b.id = r.batch_id
         WHERE a.status = 'pending' AND a.claim_deadline_at <= $1
           AND ra.status = 'assigned' AND r.status = 'assigned'
           AND b.status IN ('queued','dispatching','scheduled','running')
         ORDER BY a.claim_deadline_at, a.id
         LIMIT $2 FOR UPDATE OF a SKIP LOCKED`,
        [input.now, remaining],
      );
      const recoveredAttempts: RecoveredAttemptExpiration[] = [];
      for (const expired of [...active.rows, ...unclaimed.rows]) {
        const eventId = input.eventIds[recovered];
        if (!eventId) break;
        if ("lease_id" in expired) {
          await client.query(
            "UPDATE assignment_leases SET status = 'expired' WHERE id = $1 AND status = 'active'",
            [expired.lease_id],
          );
        }
        const detail = await expireAttempt(
          client,
          expired.assignment_id,
          expired.attempt_id,
          input.now,
          eventId,
          expired.expiration_reason,
        );
        if (detail) {
          recovered += 1;
          recoveredAttempts.push(detail);
        }
      }
      return recoveredAttempts;
    });
  }

  async terminateBatch(
    input: Parameters<ExecutionControlRepository["terminateBatch"]>[0],
  ): Promise<number> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const batch = await client.query<{
        status: RunBatchStatus;
        version: number;
        cancel_requested_at: string | null;
      }>("SELECT status, version, cancel_requested_at FROM run_batches WHERE id = $1 FOR UPDATE", [
        input.batchId,
      ]);
      const batchState = batch.rows[0];
      if (!batchState) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      if (isTerminalBatchStatus(batchState.status)) return 0;
      if (!batchState.cancel_requested_at) {
        const termination = await client.query(
          `UPDATE run_batches SET cancel_requested_at = $1, updated_at = $1, version = version + 1
           WHERE id = $2 AND version = $3 AND cancel_requested_at IS NULL`,
          [input.requestedAt, input.batchId, batchState.version],
        );
        if (termination.rowCount !== 1) {
          throw new DomainError("RUN_BATCH_VERSION_CONFLICT", "执行批次已被并发修改。");
        }
      }
      const changed = await terminateWaitingRuns(
        client,
        input.batchId,
        input.reason,
        input.requestedAt,
      );
      await updateBatchStatus(
        client,
        input.batchId,
        input.requestedAt,
        input.eventId,
        "batch.termination_requested",
      );
      return changed;
    });
  }

  async cancelRun(input: Parameters<ExecutionControlRepository["cancelRun"]>[0]): Promise<boolean> {
    await this.handle.ready;
    return this.transaction((client) => cancelRun(client, input));
  }

  private async claimReplay(
    client: PoolClient,
    runnerId: string,
    requestId: string,
  ): Promise<ClaimedAssignmentRecord[] | null> {
    const result = await client.query<{ response_json: string }>(
      "SELECT response_json FROM assignment_claim_requests WHERE runner_id = $1 AND request_id = $2",
      [runnerId, requestId],
    );
    const request = result.rows[0];
    if (!request) return null;
    const references = JSON.parse(request.response_json) as Array<{
      assignmentId: string;
      leaseId: string;
    }>;
    const replay: ClaimedAssignmentRecord[] = [];
    for (const reference of references) {
      const assignment = await requiredAssignment(client, reference.assignmentId);
      const lease = await requiredLease(client, reference.leaseId);
      replay.push({
        assignment: mapAssignment(assignment),
        lease: {
          id: lease.id,
          tokenEncrypted: lease.token_encrypted,
          version: lease.version,
          expiresAt: lease.expires_at,
        },
      });
    }
    return replay;
  }

  private async saveClaimRequest(
    client: PoolClient,
    runnerId: string,
    requestId: string,
    references: Array<{ assignmentId: string; leaseId: string }>,
    createdAt: string,
  ): Promise<void> {
    await client.query(
      "INSERT INTO assignment_claim_requests (runner_id, request_id, response_json, created_at) VALUES ($1, $2, $3, $4)",
      [runnerId, requestId, JSON.stringify(references), createdAt],
    );
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.handle.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function authorizedTransferContext(
  client: Pick<PoolClient, "query">,
  input: { runnerId: string; attemptId: string; leaseTokenHash: string; now: string },
  lock = false,
): Promise<{ assignment: AssignmentRow }> {
  const result = await client.query<
    AssignmentRow & { token_hash: string; lease_status: string; expires_at: string }
  >(
    `SELECT a.*, l.token_hash, l.status AS lease_status, l.expires_at
     FROM assignments a JOIN assignment_leases l ON l.assignment_id = a.id
     WHERE a.attempt_id = $1 ORDER BY l.created_at DESC LIMIT 1${lock ? " FOR UPDATE OF l" : ""}`,
    [input.attemptId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.runner_id !== input.runnerId ||
    row.token_hash !== input.leaseTokenHash ||
    row.lease_status !== "active" ||
    new Date(row.expires_at).toISOString() <= input.now
  ) {
    throw new DomainError("ATTEMPT_TRANSFER_FORBIDDEN", "日志或产物传输未获得有效租约授权。");
  }
  return { assignment: row };
}

async function artifactRow(
  client: Pick<PoolClient, "query">,
  attemptId: string,
  artifactId: string,
): Promise<ArtifactRow | undefined> {
  const result = await client.query<ArtifactRow>(
    "SELECT * FROM attempt_artifacts WHERE attempt_id = $1 AND id = $2",
    [attemptId, artifactId],
  );
  return result.rows[0];
}

function sameArtifact(row: ArtifactRow, artifact: ArtifactDeclaration): boolean {
  return (
    row.relative_path === artifact.relativePath &&
    row.media_type === artifact.mediaType &&
    Number(row.size_bytes) === artifact.sizeBytes &&
    row.sha256 === artifact.sha256 &&
    row.required === artifact.required
  );
}

function mapArtifactRow(row: ArtifactRow) {
  return {
    artifactId: row.id,
    relativePath: row.relative_path,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    required: row.required,
    status: row.status,
    ...(row.object_key ? { objectKey: row.object_key } : {}),
  };
}

async function persistCompletion(
  client: PoolClient,
  attemptLogs: AttemptLogStore,
  control: AttemptControlRow,
  assignment: AssignmentRow,
  lease: LeaseRow,
  result: CompletionResult,
  input: Parameters<ExecutionControlRepository["completeAttempt"]>[0],
  runStatus: "queued" | "succeeded" | "failed" | "cancelled",
): Promise<RunBatchStatus> {
  const attemptStatus = transitionRunAttempt(control.status, result.status);
  const assignmentStatus = transitionAssignment(assignment.status, "completed");
  const leaseStatus = transitionLease(lease.status, "released");
  const executionRunStatus = transitionExecutionRun(control.run_status, runStatus);
  await client.query(
    `UPDATE run_attempts SET status = $1, outcome = $1, result_code = $2, result_summary = $3,
     completion_digest = $4, duration_ms = $5, testng_result_json = $6, finished_at = $7,
     version = version + 1
     WHERE id = $8 AND status IN ('assigned', 'running')`,
    [
      attemptStatus,
      result.resultCode,
      result.summary,
      input.resultDigest,
      result.durationMs,
      result.testNg ? JSON.stringify(result.testNg) : null,
      input.acceptedAt,
      input.attemptId,
    ],
  );
  await client.query(
    `UPDATE assignments SET status = $1, completed_at = $2, updated_at = $2, version = version + 1
     WHERE id = $3 AND status IN ('claimed', 'running')`,
    [assignmentStatus, input.acceptedAt, assignment.id],
  );
  await client.query(
    "UPDATE assignment_leases SET status = $1 WHERE id = $2 AND status = 'active'",
    [leaseStatus, lease.id],
  );
  await client.query(
    `UPDATE execution_runs SET status = $1, terminal_outcome = $2, assigned_runner_id = $3,
     terminal_reason_code = $4, held_round = $5, updated_at = $6, version = version + 1
     WHERE id = $7 AND status IN ('assigned', 'running')`,
    [
      executionRunStatus,
      executionRunStatus === "queued" ? null : attemptStatus,
      executionRunStatus === "queued" ? null : control.runner_id,
      executionRunStatus === "queued" ? null : result.resultCode,
      executionRunStatus === "queued" &&
      control.retry_mode === "round" &&
      !isRetryableRunnerFailure(result.resultCode)
        ? control.attempt_number + 1
        : 0,
      input.acceptedAt,
      control.execution_run_id,
    ],
  );
  await persistCompletionMetadata(
    client,
    attemptLogs,
    control.batch_id,
    input.attemptId,
    result,
    input.acceptedAt,
  );
  await appendAttemptEvent(client, {
    id: input.eventId,
    attemptId: input.attemptId,
    eventType: "attempt.completed",
    fromStatus: control.status,
    toStatus: attemptStatus,
    actorType: "runner",
    actorId: input.runnerId,
    details: { resultCode: result.resultCode, retryScheduled: runStatus === "queued" },
    recordedAt: input.acceptedAt,
  });
  if (runStatus === "queued") {
    await appendRetryAudit(client, {
      id: input.auditEventId ?? input.eventId,
      runId: control.execution_run_id,
      projectId: control.project_id,
      attemptNumber: control.attempt_number,
      resultCode: result.resultCode,
      recordedAt: input.acceptedAt,
    });
  }
  return updateBatchStatus(
    client,
    control.batch_id,
    input.acceptedAt,
    input.eventId,
    "attempt.completed",
  );
}

async function persistCompletionMetadata(
  client: PoolClient,
  attemptLogs: AttemptLogStore,
  batchId: string,
  attemptId: string,
  result: CompletionResult,
  recordedAt: string,
): Promise<void> {
  for (const artifact of result.artifacts) {
    await client.query(
      `INSERT INTO attempt_artifacts
       (id, attempt_id, relative_path, media_type, size_bytes, sha256, required, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'declared', $8, $8)
       ON CONFLICT(attempt_id, relative_path) DO NOTHING`,
      [
        artifact.artifactId,
        attemptId,
        artifact.relativePath,
        artifact.mediaType,
        artifact.sizeBytes,
        artifact.sha256,
        artifact.required,
        recordedAt,
      ],
    );
  }
  if (result.logWatermarks) {
    // Agent 上报的水位写入批次日志文件；主库不再保存日志水位。
    attemptLogs.recordWatermarks({
      batchId,
      attemptId,
      watermarks: result.logWatermarks,
      recordedAt,
    });
  }
}

async function expireAttempt(
  client: PoolClient,
  assignmentId: string,
  attemptId: string,
  recordedAt: string,
  eventId: string,
  expirationReason: AttemptRecoveryReason,
): Promise<RecoveredAttemptExpiration | null> {
  const control = await findAttemptControl(client, attemptId);
  if (!control || isTerminalAttemptStatus(control.status)) return null;
  const expiration = attemptExpiration(expirationReason);
  const failureCounts = await executionFailureCounts(client, control.execution_run_id);
  const decision = outcomeAfterCompletion({
    outcome: "timed_out",
    attemptNumber: control.attempt_number,
    retryLimit: control.retry_limit,
    cancellationRequested: control.run_cancel_requested_at !== null,
    retryableRunnerFailure: isRetryableRunnerFailure(expiration.resultCode),
    runnerFailuresBefore: failureCounts.runner,
    ordinaryFailuresBefore: failureCounts.ordinary,
    retrySuppressed: control.batch_termination_requested_at !== null,
  });
  const attemptStatus = transitionRunAttempt(control.status, "timed_out");
  const runStatus = transitionExecutionRun(control.run_status, decision.runStatus);
  const assignment = await requiredAssignment(client, assignmentId);
  const assignmentStatus = transitionAssignment(assignment.status, "expired");
  await client.query(
    "UPDATE assignments SET status = $1, updated_at = $2, version = version + 1 WHERE id = $3 AND status IN ('pending', 'claimed', 'running')",
    [assignmentStatus, recordedAt, assignmentId],
  );
  await client.query(
    `UPDATE run_attempts SET status = 'timed_out', outcome = 'timed_out', result_code = $1,
     result_summary = $2, finished_at = $3, version = version + 1
     WHERE id = $4 AND status IN ('assigned', 'running')`,
    [expiration.resultCode, expiration.summary, recordedAt, attemptId],
  );
  await client.query(
    `UPDATE execution_runs SET status = $1, terminal_outcome = $2, assigned_runner_id = NULL,
     terminal_reason_code = $3, held_round = $4, updated_at = $5, version = version + 1
     WHERE id = $6 AND status IN ('assigned', 'running')`,
    [
      runStatus,
      runStatus === "queued" ? null : attemptStatus,
      runStatus === "queued" ? null : expiration.resultCode,
      runStatus === "queued" &&
      control.retry_mode === "round" &&
      !isRetryableRunnerFailure(expiration.resultCode)
        ? control.attempt_number + 1
        : 0,
      recordedAt,
      control.execution_run_id,
    ],
  );
  await appendAttemptEvent(client, {
    id: eventId,
    attemptId,
    eventType: expiration.eventType,
    fromStatus: control.status,
    toStatus: attemptStatus,
    reasonCode: expiration.resultCode,
    actorType: "system",
    details: { retryScheduled: decision.retryScheduled },
    recordedAt,
  });
  if (decision.retryScheduled) {
    await appendRetryAudit(client, {
      id: eventId,
      runId: control.execution_run_id,
      projectId: control.project_id,
      attemptNumber: control.attempt_number,
      resultCode: expiration.resultCode,
      recordedAt,
    });
  }
  await updateBatchStatus(client, control.batch_id, recordedAt, eventId, expiration.eventType);
  return {
    attemptId,
    batchId: control.batch_id,
    executionRunId: control.execution_run_id,
    runnerId: expirationReason === "claim_timeout" ? null : control.runner_id,
    reason: expirationReason,
    retryScheduled: decision.retryScheduled,
  };
}

async function executionFailureCounts(
  client: PoolClient,
  executionRunId: string,
): Promise<{ runner: number; ordinary: number }> {
  const result = await client.query<{ result_code: string | null }>(
    `SELECT result_code FROM run_attempts
     WHERE execution_run_id = $1 AND status IN ('failed', 'timed_out')`,
    [executionRunId],
  );
  let runner = 0;
  let ordinary = 0;
  for (const row of result.rows) {
    if (isRetryableRunnerFailure(row.result_code)) runner += 1;
    else ordinary += 1;
  }
  return { runner, ordinary };
}

async function cancelRun(
  client: PoolClient,
  input: {
    runId: string;
    actorId: string;
    reason: string;
    eventId: string;
    requestedAt: string;
  },
): Promise<boolean> {
  const result = await client.query<{
    id: string;
    batch_id: string;
    status: ExecutionRunStatus;
  }>("SELECT id, batch_id, status FROM execution_runs WHERE id = $1 FOR UPDATE", [input.runId]);
  const run = result.rows[0];
  if (!run) return false;
  if (isTerminalRunStatus(run.status)) return true;
  const attemptResult = await client.query<{ id: string; status: RunAttemptStatus }>(
    "SELECT id, status FROM run_attempts WHERE execution_run_id = $1 ORDER BY attempt_number DESC LIMIT 1",
    [input.runId],
  );
  const attempt = attemptResult.rows[0];
  const assignment = attempt ? await assignmentForAttempt(client, attempt.id) : undefined;
  const lease = assignment ? await latestLeaseForAssignment(client, assignment.id) : undefined;
  if (attempt && assignment && lease?.status === "active" && lease.expires_at > input.requestedAt) {
    await client.query(
      "UPDATE execution_runs SET cancel_requested_at = $1, updated_at = $1, version = version + 1 WHERE id = $2",
      [input.requestedAt, input.runId],
    );
    await client.query(
      "UPDATE assignments SET cancel_requested_at = $1, updated_at = $1, version = version + 1 WHERE id = $2",
      [input.requestedAt, assignment.id],
    );
    return true;
  }
  if (assignment && !["completed", "cancelled", "expired"].includes(assignment.status)) {
    const assignmentStatus = transitionAssignment(assignment.status, "cancelled");
    await client.query(
      "UPDATE assignments SET status = $1, cancel_requested_at = $2, updated_at = $2, version = version + 1 WHERE id = $3",
      [assignmentStatus, input.requestedAt, assignment.id],
    );
    await client.query(
      "UPDATE assignment_leases SET status = 'revoked' WHERE assignment_id = $1 AND status = 'active'",
      [assignment.id],
    );
  }
  if (attempt && !isTerminalAttemptStatus(attempt.status)) {
    const attemptStatus = transitionRunAttempt(attempt.status, "cancelled");
    await client.query(
      `UPDATE run_attempts SET status = 'cancelled', outcome = 'cancelled', result_code = 'CANCELLED_BY_USER',
       result_summary = $1, finished_at = $2, version = version + 1 WHERE id = $3`,
      [input.reason, input.requestedAt, attempt.id],
    );
    await appendAttemptEvent(client, {
      id: input.eventId,
      attemptId: attempt.id,
      eventType: "attempt.cancelled",
      fromStatus: attempt.status,
      toStatus: attemptStatus,
      actorType: "user",
      actorId: input.actorId,
      details: { reason: input.reason },
      recordedAt: input.requestedAt,
    });
  }
  const runStatus = transitionExecutionRun(run.status, "cancelled");
  await client.query(
    `UPDATE execution_runs SET status = $1, terminal_outcome = 'cancelled',
     terminal_reason_code = 'CANCELLED_BY_USER', cancel_requested_at = $2,
     updated_at = $2, version = version + 1 WHERE id = $3`,
    [runStatus, input.requestedAt, input.runId],
  );
  await updateBatchStatus(client, run.batch_id, input.requestedAt, input.eventId, "run.cancelled");
  return true;
}

/** 集合式关闭未开始的工作，避免 10 万级任务逐行往返；有效租约是唯一保留条件。 */
async function terminateWaitingRuns(
  client: PoolClient,
  batchId: string,
  reason: string,
  requestedAt: string,
): Promise<number> {
  await client.query(
    `UPDATE assignments a SET status = 'cancelled', updated_at = $1, version = version + 1
     WHERE a.batch_id = $2 AND a.status IN ('pending', 'claimed', 'running')
       AND NOT (
         a.status IN ('claimed', 'running') AND EXISTS (
           SELECT 1 FROM assignment_leases l
           WHERE l.assignment_id = a.id AND l.status = 'active' AND l.expires_at > $1
         )
       )`,
    [requestedAt, batchId],
  );
  await client.query(
    `UPDATE assignment_leases l SET status = 'revoked'
     WHERE l.status = 'active' AND EXISTS (
       SELECT 1 FROM assignments a
       WHERE a.id = l.assignment_id AND a.batch_id = $1 AND a.status = 'cancelled'
     )`,
    [batchId],
  );
  await client.query(
    `UPDATE run_attempts ra SET status = 'cancelled', outcome = 'cancelled',
     result_code = 'BATCH_TERMINATED_BEFORE_EXECUTION', result_summary = $1,
     finished_at = $2, version = version + 1
     WHERE ra.status IN ('assigned', 'running')
       AND EXISTS (
         SELECT 1 FROM execution_runs er WHERE er.id = ra.execution_run_id AND er.batch_id = $3
       )
       AND NOT EXISTS (
         SELECT 1 FROM assignments a JOIN assignment_leases l ON l.assignment_id = a.id
         WHERE a.attempt_id = ra.id AND a.status IN ('claimed', 'running')
           AND l.status = 'active' AND l.expires_at > $2
       )`,
    [reason, requestedAt, batchId],
  );
  const runs = await client.query(
    `UPDATE execution_runs er SET status = 'cancelled', terminal_outcome = 'cancelled',
     terminal_reason_code = 'BATCH_TERMINATED_BEFORE_EXECUTION', cancel_requested_at = $1,
     updated_at = $1, version = version + 1
     WHERE er.batch_id = $2 AND er.status NOT IN ('succeeded', 'failed', 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM run_attempts ra
         JOIN assignments a ON a.attempt_id = ra.id
         JOIN assignment_leases l ON l.assignment_id = a.id
         WHERE ra.execution_run_id = er.id
           AND ra.status IN ('assigned', 'running')
           AND a.status IN ('claimed', 'running')
           AND l.status = 'active' AND l.expires_at > $1
       )`,
    [requestedAt, batchId],
  );
  return runs.rowCount ?? 0;
}

async function requiredAssignment(
  client: PoolClient,
  assignmentId: string,
): Promise<AssignmentRow> {
  const result = await client.query<AssignmentRow>("SELECT * FROM assignments WHERE id = $1", [
    assignmentId,
  ]);
  if (!result.rows[0]) throw new DomainError("ASSIGNMENT_NOT_FOUND", "指定的 assignment 不存在。");
  return result.rows[0];
}

async function assignmentForAttempt(
  client: PoolClient,
  attemptId: string,
): Promise<AssignmentRow | undefined> {
  const result = await client.query<AssignmentRow>(
    "SELECT * FROM assignments WHERE attempt_id = $1",
    [attemptId],
  );
  return result.rows[0];
}

async function requiredLease(client: PoolClient, leaseId: string, lock = false): Promise<LeaseRow> {
  const result = await client.query<LeaseRow>(
    `SELECT * FROM assignment_leases WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [leaseId],
  );
  if (!result.rows[0]) throw new DomainError("LEASE_NOT_FOUND", "指定的租约不存在。");
  return result.rows[0];
}

async function latestLeaseForAssignment(
  client: PoolClient,
  assignmentId: string,
): Promise<LeaseRow | undefined> {
  const result = await client.query<LeaseRow>(
    "SELECT * FROM assignment_leases WHERE assignment_id = $1 ORDER BY created_at DESC LIMIT 1",
    [assignmentId],
  );
  return result.rows[0];
}

async function requiredAttemptControl(
  client: PoolClient,
  attemptId: string,
  lock = false,
): Promise<AttemptControlRow> {
  const row = await findAttemptControl(client, attemptId, lock);
  if (!row) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
  return row;
}

async function findAttemptControl(
  client: PoolClient,
  attemptId: string,
  lock = false,
): Promise<AttemptControlRow | undefined> {
  const result = await client.query<AttemptControlRow>(
    `SELECT a.id, a.execution_run_id, a.runner_id, a.attempt_number, a.status,
     r.status AS run_status, r.cancel_requested_at AS run_cancel_requested_at,
     b.retry_limit, b.retry_mode, b.id AS batch_id, b.project_id,
     b.cancel_requested_at AS batch_termination_requested_at
     FROM run_attempts a JOIN execution_runs r ON r.id = a.execution_run_id
     JOIN run_batches b ON b.id = r.batch_id WHERE a.id = $1${lock ? " FOR UPDATE OF a, r" : ""}`,
    [attemptId],
  );
  return result.rows[0];
}

async function appendRetryAudit(
  client: PoolClient,
  input: {
    id: string;
    runId: string;
    projectId: string;
    attemptNumber: number;
    resultCode: string;
    recordedAt: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
     (id, actor_type, action, resource_type, resource_id, project_id, result, details_json, recorded_at)
     VALUES ($1, 'system', 'execution_run.retry_scheduled', 'execution_run', $2, $3, 'succeeded', $4, $5)`,
    [
      input.id,
      input.runId,
      input.projectId,
      JSON.stringify({ attemptNumber: input.attemptNumber, resultCode: input.resultCode }),
      input.recordedAt,
    ],
  );
}

async function appendAttemptEvent(
  client: PoolClient,
  input: {
    id: string;
    attemptId: string;
    eventType: string;
    fromStatus?: string;
    toStatus?: string;
    reasonCode?: string;
    actorType: "user" | "runner" | "system";
    actorId?: string;
    details: Record<string, unknown>;
    recordedAt: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO attempt_state_events
     (id, attempt_id, event_type, from_status, to_status, reason_code, actor_type, actor_id, details_json, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      input.attemptId,
      input.eventType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.reasonCode ?? null,
      input.actorType,
      input.actorId ?? null,
      JSON.stringify(input.details),
      input.recordedAt,
    ],
  );
}

async function updateBatchStatus(
  client: PoolClient,
  batchId: string,
  updatedAt: string,
  eventId: string,
  reason: string,
): Promise<RunBatchStatus> {
  const batch = await client.query<{
    status: RunBatchStatus;
    version: number;
    retry_mode: "immediate" | "round";
    cancel_requested_at: string | null;
  }>("SELECT status, version, retry_mode, cancel_requested_at FROM run_batches WHERE id = $1", [
    batchId,
  ]);
  let batchState = batch.rows[0];
  if (!batchState) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
  // 轮次制下先释放等待下一轮的失败 run，再聚合状态，确保释放的 run 计入批次状态。
  if (!batchState.cancel_requested_at) {
    await advanceRoundIfIdle(client, batchId, batchState.retry_mode, updatedAt);
  }
  let status = await aggregateStoredBatchStatus(
    client,
    batchId,
    batchState.cancel_requested_at !== null,
  );
  transitionRunBatch(batchState.status, status);
  // 高频完成上报的批次状态通常仍是 running，快路径不锁、不写热点批次行。
  if (batchState.status === status) return status;

  // 只有生命周期真正可能变化时才串行化批次行，并在锁内重新读取聚合状态。
  const lockedBatch = await client.query<{
    status: RunBatchStatus;
    version: number;
    retry_mode: "immediate" | "round";
    cancel_requested_at: string | null;
  }>(
    "SELECT status, version, retry_mode, cancel_requested_at FROM run_batches WHERE id = $1 FOR UPDATE",
    [batchId],
  );
  batchState = lockedBatch.rows[0];
  if (!batchState) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
  if (!batchState.cancel_requested_at) {
    await advanceRoundIfIdle(client, batchId, batchState.retry_mode, updatedAt);
  }
  status = await aggregateStoredBatchStatus(
    client,
    batchId,
    batchState.cancel_requested_at !== null,
  );
  transitionRunBatch(batchState.status, status);
  if (batchState.status === status) return status;
  const update = await client.query(
    `UPDATE run_batches SET status = $1, updated_at = $2, version = version + 1
     WHERE id = $3 AND version = $4`,
    [status, updatedAt, batchId, batchState.version],
  );
  if (update.rowCount !== 1) {
    throw new DomainError("RUN_BATCH_VERSION_CONFLICT", "执行批次已被并发修改。");
  }
  if (batchState.status !== status) {
    await client.query(
      `INSERT INTO run_batch_status_events
       (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventId, batchId, batchState.status, status, batchState.version + 1, reason, updatedAt],
    );
  }
  return status;
}

/** 用索引存在性查询短路运行态，避免每次完成都扫描并传输整个任务。 */
async function aggregateStoredBatchStatus(
  client: PoolClient,
  batchId: string,
  terminationRequested: boolean,
): Promise<RunBatchStatus> {
  const statusPresence = await client.query<{
    running: boolean;
    assigned: boolean;
    queued: boolean;
    cancelled: boolean;
  }>(
    `SELECT
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'running') AS running,
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'assigned') AS assigned,
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'queued') AS queued,
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'cancelled') AS cancelled`,
    [batchId],
  );
  const presence = statusPresence.rows[0];
  if (presence?.running) return aggregateBatchStatus(["running"]);
  if (presence?.assigned) {
    return aggregateBatchStatus(presence.queued ? ["assigned", "queued"] : ["assigned"]);
  }
  if (presence?.queued) return aggregateBatchStatus(["queued"]);
  if (terminationRequested || presence?.cancelled) {
    return aggregateBatchStatus(["cancelled"], { terminationRequested });
  }
  const failures = await client.query<{ terminal_reason_code: string | null }>(
    `SELECT DISTINCT terminal_reason_code FROM execution_runs
     WHERE batch_id = $1 AND status = 'failed'`,
    [batchId],
  );
  return aggregateBatchStatus([
    "succeeded",
    ...failures.rows.map(({ terminal_reason_code: terminalReasonCode }) => ({
      status: "failed",
      ...(terminalReasonCode ? { terminalReasonCode } : {}),
    })),
  ]);
}

// late 路径不经过 persistCompletion，直接读当前批次聚合状态判定终态。
async function batchClosed(client: PoolClient, batchId: string): Promise<boolean> {
  const row = await client.query<{ status: RunBatchStatus }>(
    "SELECT status FROM run_batches WHERE id = $1",
    [batchId],
  );
  return row.rows[0] ? isTerminalBatchStatus(row.rows[0].status) : false;
}

// 轮次制：整轮无在途且无未扣留的 queued run 时，把等待下一轮的失败 run 统一释放。
async function advanceRoundIfIdle(
  client: PoolClient,
  batchId: string,
  retryMode: "immediate" | "round",
  updatedAt: string,
): Promise<void> {
  if (retryMode !== "round") return;
  const inFlight = await client.query<{ value: string }>(
    "SELECT COUNT(*) AS value FROM execution_runs WHERE batch_id = $1 AND status IN ('assigned', 'running')",
    [batchId],
  );
  if (Number(inFlight.rows[0]?.value ?? 0) > 0) return;
  const schedulable = await client.query<{ value: string }>(
    "SELECT COUNT(*) AS value FROM execution_runs WHERE batch_id = $1 AND status = 'queued' AND held_round = 0",
    [batchId],
  );
  if (Number(schedulable.rows[0]?.value ?? 0) > 0) return;
  const nextRound = await client.query<{ value: number | null }>(
    "SELECT MIN(held_round) AS value FROM execution_runs WHERE batch_id = $1 AND status = 'queued' AND held_round > 0",
    [batchId],
  );
  const nextRoundValue = nextRound.rows[0]?.value;
  if (nextRoundValue === null || nextRoundValue === undefined) return;
  await client.query(
    `UPDATE execution_runs SET held_round = 0, updated_at = $1
     WHERE batch_id = $2 AND status = 'queued' AND held_round <= $3`,
    [updatedAt, batchId, nextRoundValue],
  );
  await client.query("UPDATE run_batches SET current_round = $1, updated_at = $2 WHERE id = $3", [
    nextRoundValue,
    updatedAt,
    batchId,
  ]);
}

function mapAssignment(row: AssignmentRow): AssignmentDto {
  return {
    schemaVersion: 1,
    assignmentId: row.id,
    attemptId: row.attempt_id,
    runnerId: row.runner_id,
    priority: row.priority,
    availableAt: row.available_at,
    claimDeadlineAt: row.claim_deadline_at,
    createdAt: row.created_at,
    executionSpec: parseSpec(row),
  };
}

function parseSpec(row: AssignmentRow) {
  return executionSpecSchema.parse(JSON.parse(row.execution_spec_json));
}

function matchesAgent(
  spec: ReturnType<typeof parseSpec>,
  labels: readonly string[],
  capabilities: readonly string[],
): boolean {
  const labelSet = new Set(labels);
  const capabilitySet = new Set(capabilities);
  return (
    spec.requiredLabels.every((label) => labelSet.has(label)) &&
    spec.requiredCapabilities.every((capability) => capabilitySet.has(capability))
  );
}

function attemptExpiration(reason: AttemptRecoveryReason): {
  eventType: string;
  resultCode: string;
  summary: string;
} {
  switch (reason) {
    case "claim_timeout":
      return {
        eventType: "assignment.claim_timed_out",
        resultCode: "ASSIGNMENT_CLAIM_TIMEOUT",
        summary: "Assignment was not claimed before its deadline.",
      };
    case "execution_timeout":
      return {
        eventType: "attempt.execution_timed_out",
        resultCode: "EXECUTION_TIMEOUT",
        summary: "Execution exceeded its configured timeout.",
      };
    case "upload_timeout":
      return {
        eventType: "attempt.upload_timed_out",
        resultCode: "UPLOAD_TIMEOUT",
        summary: "Artifact upload and completion exceeded the configured timeout.",
      };
    case "lease_expired":
      return {
        eventType: "lease.expired",
        resultCode: "LEASE_EXPIRED",
        summary: "Assignment lease expired before completion.",
      };
  }
}

function mapAttemptEvent(row: AttemptEventRow) {
  return {
    eventId: row.id,
    attemptId: row.attempt_id,
    eventType: row.event_type,
    ...(row.from_status ? { fromStatus: row.from_status } : {}),
    ...(row.to_status ? { toStatus: row.to_status } : {}),
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
    actorType: row.actor_type,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    details: JSON.parse(row.details_json) as unknown,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

function cancellationResult(
  result: CompletionResult,
  cancelRequestedAt: string | null,
): CompletionResult {
  if (!cancelRequestedAt || result.status === "cancelled") return result;
  return {
    ...result,
    status: "cancelled",
    resultCode: "CANCELLED_BY_CONTROL_PLANE",
    summary: "控制面取消请求先于完成上报生效。",
  };
}

function rememberBounded(values: Set<string>, value: string): void {
  values.add(value);
  if (values.size <= 1_024) return;
  const oldest = values.values().next().value as string | undefined;
  if (oldest) values.delete(oldest);
}
