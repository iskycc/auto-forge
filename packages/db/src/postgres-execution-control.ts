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
import type { PoolClient, QueryResult } from "pg";

import type { AttemptLogStore } from "./attempt-log-store";
import { queueDeadlineAfter, retryQueueTiming } from "./execution-queue-timing";
import type { SchedulingEventDraft } from "@autoforge/application";
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
  queue_timeout_ms: number;
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
        .slice(0, Math.min(input.availableSlots, input.leaseSeeds.length));
      // 批量领取：候选行已被上方 FOR UPDATE 锁定。旧实现每个 assignment 串行
      // 5 条语句（64 槽约 320 次往返），高并发下领取事务长时间占用事件循环；
      // 现在整组候选用 5 条集合语句完成，逐行守卫（状态、批次未取消）保留在
      // 条件中，成功集合经 RETURNING 回传后按候选原顺序配对租约种子。
      const claimedIds = await bulkClaimAssignments(client, {
        candidateIds: selected.map((assignment) => assignment.id),
        now: input.now,
      });
      const claimedSet = new Set(claimedIds);
      // 租约种子按候选原顺序配对：失败行占据的种子作废，与逐行实现一致。
      const claimPairs: Array<{ assignment: AssignmentRow; seed: ClaimLeaseSeed }> = [];
      for (const [index, assignment] of selected.entries()) {
        if (!claimedSet.has(assignment.id)) continue;
        const seed = input.leaseSeeds[index];
        if (!seed) break;
        claimPairs.push({ assignment, seed });
      }
      const claimed: ClaimedAssignmentRecord[] = [];
      const claimedBatchEvents = new Map<string, string>();
      for (const { assignment, seed } of claimPairs) {
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
      if (claimPairs.length > 0) {
        await persistBulkClaimSideEffects(client, {
          pairs: claimPairs,
          runnerId: input.runnerId,
          now: input.now,
          leaseExpiresAt: input.leaseExpiresAt,
        });
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
      // 批次状态推进放在事务最后：批次行锁只在提交前短暂持有。通用“先锁再聚合”
      // 更新会让同批次的并发领取互相排队（锁持有跨越多条语句与客户端往返），
      // 领取只会把 run 置为 running，用单语句条件迁移替代。
      for (const [batchId, eventId] of claimedBatchEvents) {
        await markBatchActiveOnClaim(client, batchId, input.now, eventId);
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
    completionEvents?: Parameters<ExecutionControlRepository["completeAttempt"]>[1],
  ): Promise<CompleteAttemptResponse> {
    await this.handle.ready;
    // 完成上报是高并发最热写路径，手动管理客户端而不用通用事务包装：BEGIN 并入
    // 首个多语句束；写事务的 COMMIT 与提交后的在途聚合合并为单次往返，快路径
    // 完全不持有批次行锁（旧“先锁再聚合”使全部完成上报在批次行上串行，
    // pg_stat_statements 中单条 FOR UPDATE 累计数十秒锁等待）。只有批次最后
    // 一个完成上报触发的终态迁移/轮次收尾才在独立小事务中加锁完成。
    const client = await this.handle.pool.connect();
    try {
      const result = await this.completeAttemptTransaction(client, input, completionEvents);
      if (!result.committed) {
        await client.query("COMMIT");
      }
      if ("conflict" in result) {
        throw new DomainError("ATTEMPT_COMPLETION_CONFLICT", "该执行尝试已收到不同的完成结果。");
      }
      return result.response;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async completeAttemptTransaction(
    client: PoolClient,
    input: Parameters<ExecutionControlRepository["completeAttempt"]>[0],
    completionEvents?: Parameters<ExecutionControlRepository["completeAttempt"]>[1],
  ): Promise<
    ({ response: CompleteAttemptResponse } | { conflict: true }) & { committed: boolean }
  > {
    const { opening, receipt } = await openCompletion(client, input.attemptId);
    if (!opening) {
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    }
    const { control, assignment, lease, latestAttemptNumber, batchStatus } = opening;
    if (
      !assignment ||
      !lease ||
      lease.runner_id !== input.runnerId ||
      lease.token_hash !== input.leaseTokenHash
    ) {
      throw new DomainError("LEASE_AUTH_REJECTED", "完成上报的租约凭据无效。");
    }
    if (receipt) {
      if (receipt.result_digest !== input.resultDigest) {
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
            storedDigest: receipt.result_digest,
          },
          recordedAt: input.acceptedAt,
        });
        return { conflict: true, committed: false };
      }
      const storedResponse = completeAttemptResponseSchema.parse(JSON.parse(receipt.response_json));
      // 重复上报按当前批次状态校正；若遭遇“写事务已提交而终态迁移失败”的
      // 罕见窗口，借重放机会补做迁移，保证批次终态最终成立。
      const liveStatus = await repairBatchSettlementIfStalled(
        client,
        control.batch_id,
        input.acceptedAt,
        input.eventId,
      );
      return {
        response: {
          ...storedResponse,
          disposition: "duplicate" as const,
          ...(liveStatus !== null ? { batchClosed: isTerminalBatchStatus(liveStatus) } : {}),
        },
        committed: false,
      };
    }
    const isLate =
      lease.status !== "active" ||
      lease.expires_at <= input.acceptedAt ||
      latestAttemptNumber !== control.attempt_number ||
      isTerminalRunStatus(control.run_status);
    const response: CompleteAttemptResponse = {
      schemaVersion: 1 as const,
      completionId: input.completionId,
      acceptedAt: input.acceptedAt,
      disposition: isLate ? "late" : "accepted",
      retryScheduled: false,
      batchId: control.batch_id,
      batchClosed: isTerminalBatchStatus(batchStatus),
    };
    if (!isLate) {
      const effectiveResult = cancellationResult(input.result, control.run_cancel_requested_at);
      // succeeded 结果在领域决策中直接短路返回，不消费失败计数；跳过查询，
      // 避免每次成功完成都多付一次串行往返（高并发基准中的主路径）。
      const failureCounts =
        effectiveResult.status === "succeeded"
          ? { runner: 0, ordinary: 0 }
          : await executionFailureCounts(client, control.execution_run_id);
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
      // 调度事件工厂在写入前求值：草稿作为参数并入同一条多 CTE 语句，
      // 完成热路径不再为事件追加支付任何额外往返。
      const schedulingDrafts = completionEvents
        ? completionEvents(
            {
              batchId: control.batch_id,
              executionRunId: control.execution_run_id,
              runnerId: assignment.runner_id,
              attemptNumber: control.attempt_number,
              displayName: opening.displayName,
              ...(opening.heldRound > 0 ? { heldRound: opening.heldRound } : {}),
            },
            response.retryScheduled,
          )
        : [];
      // 回执、四条行更新与调度事件合并为单条多 CTE 语句，全部先于提交完成。
      await persistCompletionWrites(
        client,
        this.attemptLogs,
        control,
        assignment,
        lease,
        effectiveResult,
        input,
        decision.runStatus,
        JSON.stringify(response),
        schedulingDrafts,
      );
      // COMMIT 与在途聚合同一往返：聚合在提交后的新快照上评估，可见自身迁移
      // 与所有已提交完成，因此最后提交者必然观察到零在途并完成终态迁移；
      // 仍见在途的上报直接跳过，全程不持批次行锁。
      const tail = await commitWithInFlightPresence(client, control.batch_id);
      response.hasSchedulableRuns = tail.schedulable;
      if (tail.running || tail.assigned) {
        response.batchClosed = false;
        return { response, committed: true };
      }
      // 稀有路径：批次最后一个完成（或轮次收尾）触发终态迁移/轮次推进，
      // 在独立小事务中加锁完成；失败时由重复上报路径补做。
      response.batchClosed = isTerminalBatchStatus(
        await settleBatchAfterCompletion(client, control.batch_id, input.acceptedAt, input.eventId),
      );
      return { response, committed: true };
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
    return { response, committed: false };
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
    // 授权上下文一次往返同时带回 batch_id，日志追加不再额外解析批次。
    const { batchId } = await authorizedTransferContext(this.handle.pool, {
      ...input,
      now: input.receivedAt,
    });
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
         WHERE r.status = 'queued' AND r.held_round = 0 AND r.queue_deadline_at IS NOT NULL
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
           WHERE id = $2 AND status = 'queued' AND held_round = 0
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
      await client.query(
        `UPDATE run_batch_round_recoveries
         SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
         WHERE batch_id = $2 AND status IN ('idle','pending','polling','waiting','releasing')`,
        [input.requestedAt, input.batchId],
      );
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
): Promise<{ assignment: AssignmentRow; batchId: string }> {
  const result = await client.query<
    AssignmentRow & {
      token_hash: string;
      lease_status: string;
      expires_at: string;
      batch_id: string;
    }
  >(
    `SELECT a.*, l.token_hash, l.status AS lease_status, l.expires_at, r.batch_id
     FROM assignments a
     JOIN assignment_leases l ON l.assignment_id = a.id
     JOIN execution_runs r ON r.id = a.execution_run_id
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
  return { assignment: row, batchId: row.batch_id };
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

type CompletionOpening = {
  control: AttemptControlRow;
  assignment: AssignmentRow | undefined;
  lease: LeaseRow | undefined;
  latestAttemptNumber: number | null;
  batchStatus: RunBatchStatus;
  displayName: string;
  heldRound: number;
};

type CompletionOpeningRow = {
  attempt_id: string;
  execution_run_id: string;
  attempt_runner_id: string;
  attempt_number: number;
  attempt_status: RunAttemptStatus;
  run_status: ExecutionRunStatus;
  run_cancel_requested_at: string | null;
  run_display_name: string;
  run_held_round: number;
  batch_id: string;
  project_id: string;
  retry_limit: number;
  retry_mode: "immediate" | "round";
  queue_timeout_ms: number;
  batch_status: RunBatchStatus;
  batch_termination_requested_at: string | null;
  assignment_id: string | null;
  assignment_status: AssignmentStatus | null;
  assignment_priority: number | null;
  assignment_execution_spec_json: string | null;
  assignment_available_at: string | null;
  assignment_claim_deadline_at: string | null;
  assignment_claimed_at: string | null;
  assignment_completed_at: string | null;
  assignment_cancel_requested_at: string | null;
  assignment_version: number | null;
  assignment_created_at: string | null;
  assignment_updated_at: string | null;
  lease_id: string | null;
  lease_assignment_id: string | null;
  lease_runner_id: string | null;
  token_hash: string | null;
  token_encrypted: string | null;
  lease_status: LeaseRow["status"] | null;
  lease_version: number | null;
  expires_at: string | null;
  renewed_at: string | null;
  lease_created_at: string | null;
  latest_attempt_number: number | null;
};

type CompletionReceiptRow = {
  result_digest: string;
  response_json: string;
};

/**
 * 单语句取回完成上报所需的全部上下文（attempt、run、batch、assignment、最新
 * lease、run 的最新 attempt 号）。完成上报是最高频的执行机请求，拆成多次串行
 * 查询会在高并发下被 Node 事件循环间隔逐条放大延迟。
 */
const COMPLETION_OPENING_SELECT = `SELECT
       a.id AS attempt_id, a.execution_run_id, a.runner_id AS attempt_runner_id,
       a.attempt_number, a.status AS attempt_status,
       r.status AS run_status, r.cancel_requested_at AS run_cancel_requested_at,
       r.display_name AS run_display_name, r.held_round AS run_held_round,
       b.id AS batch_id, b.project_id, b.retry_limit, b.retry_mode, b.queue_timeout_ms,
       b.status AS batch_status, b.cancel_requested_at AS batch_termination_requested_at,
       asn.id AS assignment_id, asn.status AS assignment_status, asn.priority AS assignment_priority,
       asn.execution_spec_json AS assignment_execution_spec_json,
       asn.available_at AS assignment_available_at,
       asn.claim_deadline_at AS assignment_claim_deadline_at,
       asn.claimed_at AS assignment_claimed_at, asn.completed_at AS assignment_completed_at,
       asn.cancel_requested_at AS assignment_cancel_requested_at,
       asn.version AS assignment_version, asn.created_at AS assignment_created_at,
       asn.updated_at AS assignment_updated_at,
       l.id AS lease_id, l.assignment_id AS lease_assignment_id, l.runner_id AS lease_runner_id,
       l.token_hash, l.token_encrypted, l.status AS lease_status, l.version AS lease_version,
       l.expires_at, l.renewed_at, l.created_at AS lease_created_at,
       (SELECT MAX(attempt_number) FROM run_attempts
         WHERE execution_run_id = a.execution_run_id) AS latest_attempt_number
     FROM run_attempts a
     JOIN execution_runs r ON r.id = a.execution_run_id
     JOIN run_batches b ON b.id = r.batch_id
     LEFT JOIN assignments asn ON asn.attempt_id = a.id
     LEFT JOIN LATERAL (
       SELECT * FROM assignment_leases
       WHERE assignment_id = asn.id
       ORDER BY created_at DESC LIMIT 1
     ) l ON true
     WHERE a.id = $1
     FOR UPDATE OF a, r`;

function completionOpeningBundleSql(attemptLiteral: string): string {
  const openingSelect = COMPLETION_OPENING_SELECT.replace("$1", attemptLiteral);
  return `BEGIN;
    ${openingSelect};
    SELECT result_digest, response_json FROM attempt_completion_receipts
    WHERE attempt_id = ${attemptLiteral} FOR UPDATE`;
}

/**
 * 启动完成上报事务，并在简单查询协议的一次往返内完成“BEGIN + 上下文读取 +
 * 回执行锁”。简单协议不支持绑定参数，标识符经严格 UUID 校验后内联；
 * READ COMMITTED 下束内每条语句各取独立快照，先锁后读保持逐条下发的语义。
 */
async function openCompletion(
  client: PoolClient,
  attemptId: string,
): Promise<{
  opening: CompletionOpening | undefined;
  receipt: CompletionReceiptRow | undefined;
}> {
  const attemptLiteral = quoteIdentifierForInlineSql(attemptId, "执行尝试");
  const results = await executeSimpleStatementBundle(
    client,
    completionOpeningBundleSql(attemptLiteral),
  );
  const openingRow = (results[1]?.rows as CompletionOpeningRow[] | undefined)?.[0];
  const receipt = (results[2]?.rows as CompletionReceiptRow[] | undefined)?.[0];
  return { opening: completionOpeningFromRow(openingRow, attemptId), receipt };
}

function completionOpeningFromRow(
  row: CompletionOpeningRow | undefined,
  attemptId: string,
): CompletionOpening | undefined {
  if (!row) return undefined;
  const assignment: AssignmentRow | undefined = row.assignment_id
    ? {
        id: row.assignment_id,
        attempt_id: attemptId,
        execution_run_id: row.execution_run_id,
        batch_id: row.batch_id,
        runner_id: row.attempt_runner_id,
        status: row.assignment_status!,
        priority: row.assignment_priority!,
        execution_spec_json: row.assignment_execution_spec_json!,
        available_at: row.assignment_available_at!,
        claim_deadline_at: row.assignment_claim_deadline_at!,
        claimed_at: row.assignment_claimed_at,
        completed_at: row.assignment_completed_at,
        cancel_requested_at: row.assignment_cancel_requested_at,
        version: row.assignment_version!,
        created_at: row.assignment_created_at!,
        updated_at: row.assignment_updated_at!,
      }
    : undefined;
  const lease: LeaseRow | undefined = row.lease_id
    ? {
        id: row.lease_id,
        assignment_id: row.lease_assignment_id!,
        runner_id: row.lease_runner_id!,
        token_hash: row.token_hash!,
        token_encrypted: row.token_encrypted!,
        status: row.lease_status!,
        version: row.lease_version!,
        expires_at: row.expires_at!,
        renewed_at: row.renewed_at!,
        created_at: row.lease_created_at!,
      }
    : undefined;
  return {
    control: {
      id: row.attempt_id,
      execution_run_id: row.execution_run_id,
      runner_id: row.attempt_runner_id,
      attempt_number: row.attempt_number,
      status: row.attempt_status,
      run_status: row.run_status,
      retry_limit: row.retry_limit,
      retry_mode: row.retry_mode,
      queue_timeout_ms: row.queue_timeout_ms,
      batch_id: row.batch_id,
      project_id: row.project_id,
      run_cancel_requested_at: row.run_cancel_requested_at,
      batch_termination_requested_at: row.batch_termination_requested_at,
    },
    assignment,
    lease,
    latestAttemptNumber: row.latest_attempt_number,
    batchStatus: row.batch_status,
    displayName: row.run_display_name,
    heldRound: row.run_held_round,
  };
}

async function persistCompletionWrites(
  client: PoolClient,
  attemptLogs: AttemptLogStore,
  control: AttemptControlRow,
  assignment: AssignmentRow,
  lease: LeaseRow,
  result: CompletionResult,
  input: Parameters<ExecutionControlRepository["completeAttempt"]>[0],
  runStatus: "queued" | "succeeded" | "failed" | "cancelled",
  responseJson: string,
  schedulingDrafts: readonly SchedulingEventDraft[],
): Promise<void> {
  const attemptStatus = transitionRunAttempt(control.status, result.status);
  const assignmentStatus = transitionAssignment(assignment.status, "completed");
  const leaseStatus = transitionLease(lease.status, "released");
  const executionRunStatus = transitionExecutionRun(control.run_status, runStatus);
  const queueTiming = retryQueueTiming({
    runStatus: executionRunStatus,
    retryMode: control.retry_mode,
    retryableRunnerFailure: isRetryableRunnerFailure(result.resultCode),
    attemptNumber: control.attempt_number,
    eligibleAt: input.acceptedAt,
    queueTimeoutMs: control.queue_timeout_ms,
  });
  // 完成上报是高并发主路径：回执、四条互不依赖的行更新与 attempt 事件合并为
  // 单条多 CTE 语句，全部先于批次行锁完成；子语句各自只接触目标行，共享快照
  // 不影响正确性。数据修改型 CTE 无论主查询是否读取都会执行一次。
  await client.query(
    `WITH ins_receipt AS (
       INSERT INTO attempt_completion_receipts
         (attempt_id, completion_id, result_digest, response_json, accepted_at)
       VALUES ($29, $30, $31, $32, $33) RETURNING attempt_id
     ), upd_attempt AS (
       UPDATE run_attempts SET status = $1, outcome = $1, result_code = $2, result_summary = $3,
         completion_digest = $4, duration_ms = $5, testng_result_json = $6, finished_at = $7,
         version = version + 1
       WHERE id = $8 AND status IN ('assigned', 'running') RETURNING id
     ), upd_assignment AS (
       UPDATE assignments SET status = $9, completed_at = $10, updated_at = $10,
         version = version + 1
       WHERE id = $11 AND status IN ('claimed', 'running') RETURNING id
     ), upd_lease AS (
       UPDATE assignment_leases SET status = $12
       WHERE id = $13 AND status = 'active' RETURNING id
     ), upd_run AS (
       UPDATE execution_runs SET status = $14, terminal_outcome = $15, assigned_runner_id = $16,
         terminal_reason_code = $17, held_round = $18, queue_deadline_at = $19, updated_at = $20,
         version = version + 1
       WHERE id = $21 AND status IN ('assigned', 'running') RETURNING id
     ), ins_event AS (
       INSERT INTO attempt_state_events
         (id, attempt_id, event_type, from_status, to_status, reason_code,
          actor_type, actor_id, details_json, recorded_at)
       VALUES ($22, $23, 'attempt.completed', $24, $25, NULL, 'runner', $26, $27, $28)
       RETURNING id
     ), ins_sched AS (
       INSERT INTO scheduling_events
         (id, batch_id, runner_id, execution_run_id, attempt_id, event_type, message,
          payload_json, recorded_at)
       SELECT s.id, s.batch_id, s.runner_id, s.execution_run_id, s.attempt_id,
              s.event_type, s.message, s.payload_json, s.recorded_at
       FROM unnest($34::text[], $35::text[], $36::text[], $37::text[], $38::text[],
                   $39::text[], $40::text[], $41::text[], $42::text[])
         AS s(id, batch_id, runner_id, execution_run_id, attempt_id, event_type,
              message, payload_json, recorded_at)
       RETURNING id
     )
     SELECT (SELECT count(*) FROM upd_attempt) AS attempt_rows,
            (SELECT count(*) FROM upd_assignment) AS assignment_rows,
            (SELECT count(*) FROM upd_lease) AS lease_rows,
            (SELECT count(*) FROM upd_run) AS run_rows,
            (SELECT count(*) FROM ins_sched) AS sched_rows`,
    [
      attemptStatus,
      result.resultCode,
      result.summary,
      input.resultDigest,
      result.durationMs,
      result.testNg ? JSON.stringify(result.testNg) : null,
      input.acceptedAt,
      input.attemptId,
      assignmentStatus,
      input.acceptedAt,
      assignment.id,
      leaseStatus,
      lease.id,
      executionRunStatus,
      executionRunStatus === "queued" ? null : attemptStatus,
      executionRunStatus === "queued" ? null : control.runner_id,
      executionRunStatus === "queued" ? null : result.resultCode,
      queueTiming.heldRound,
      queueTiming.queueDeadlineAt,
      input.acceptedAt,
      control.execution_run_id,
      input.eventId,
      input.attemptId,
      control.status,
      attemptStatus,
      input.runnerId,
      JSON.stringify({
        resultCode: result.resultCode,
        retryScheduled: runStatus === "queued",
      }),
      input.acceptedAt,
      input.attemptId,
      input.completionId,
      input.resultDigest,
      responseJson,
      input.acceptedAt,
      schedulingDrafts.map((draft) => draft.id),
      schedulingDrafts.map((draft) => draft.batchId),
      schedulingDrafts.map((draft) => draft.runnerId ?? null),
      schedulingDrafts.map((draft) => draft.executionRunId ?? null),
      schedulingDrafts.map((draft) => draft.attemptId ?? null),
      schedulingDrafts.map((draft) => draft.eventType),
      schedulingDrafts.map((draft) => draft.message),
      schedulingDrafts.map((draft) => (draft.payload ? JSON.stringify(draft.payload) : null)),
      schedulingDrafts.map((draft) => draft.recordedAt),
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
}

/**
 * 写事务的 COMMIT、提交后的在途聚合与可调度探针同属简单查询协议的一次往返。
 * READ COMMITTED 下 COMMIT 之后的语句取新快照，聚合可见自身迁移与所有已提交
 * 的其他完成：最后提交的上报必然观察到零在途并驱动终态迁移，其余上报安全跳过。
 * 可调度探针（存在未被扣留的 queued run）供路由层决定是否触发补调度，避免每次
 * 完成都额外支付一次调度短路查询。
 */
async function commitWithInFlightPresence(
  client: PoolClient,
  batchId: string,
): Promise<BatchTailSnapshot> {
  const batchLiteral = quoteIdentifierForInlineSql(batchId, "执行批次");
  const results = await executeSimpleStatementBundle(
    client,
    `COMMIT;
     SELECT
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = ${batchLiteral} AND status = 'running') AS running,
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = ${batchLiteral} AND status = 'assigned') AS assigned,
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = ${batchLiteral} AND status = 'queued' AND held_round = 0) AS schedulable`,
  );
  const presence = (results[1]?.rows as BatchTailSnapshot[] | undefined)?.[0];
  return presence ?? { running: false, assigned: false, schedulable: false };
}

/**
 * 稀有路径：完成写事务已提交后，以独立小事务完成终态迁移或轮次收尾。
 * updateBatchStatus 内部完成批次行加锁、聚合与版本化写入；此步失败时，
 * 重复上报路径经 repairBatchSettlementIfStalled 补做，终态不会丢失。
 */
async function settleBatchAfterCompletion(
  client: PoolClient,
  batchId: string,
  updatedAt: string,
  eventId: string,
): Promise<RunBatchStatus> {
  await client.query("BEGIN");
  try {
    const status = await updateBatchStatus(
      client,
      batchId,
      updatedAt,
      eventId,
      "attempt.completed",
    );
    await client.query("COMMIT");
    return status;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

/**
 * 重复上报的批次终态校正：读取当前批次状态；若批次停留在非终态且已无在途
 * run（对应“完成已提交而终态迁移失败”的罕见窗口），就地补做迁移。
 * 批次行不存在时返回 null，调用方保留存储回执中的原值。
 */
async function repairBatchSettlementIfStalled(
  client: PoolClient,
  batchId: string,
  updatedAt: string,
  eventId: string,
): Promise<RunBatchStatus | null> {
  const statusRow = await client.query<{ status: RunBatchStatus }>(
    "SELECT status FROM run_batches WHERE id = $1",
    [batchId],
  );
  const currentStatus = statusRow.rows[0]?.status;
  if (!currentStatus) return null;
  if (isTerminalBatchStatus(currentStatus)) return currentStatus;
  const presence = await inFlightPresence(client, batchId);
  if (presence.running || presence.assigned) return currentStatus;
  return updateBatchStatus(client, batchId, updatedAt, eventId, "attempt.completed");
}

type BatchInFlightRow = {
  running: boolean;
  assigned: boolean;
};

type BatchTailSnapshot = BatchInFlightRow & {
  schedulable: boolean;
};

async function inFlightPresence(client: PoolClient, batchId: string): Promise<BatchInFlightRow> {
  const result = await client.query<BatchInFlightRow>(
    `SELECT
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'running') AS running,
       EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'assigned') AS assigned`,
    [batchId],
  );
  return result.rows[0] ?? { running: false, assigned: false };
}

/** 连接可能已断开或事务已提交；ROLLBACK 失败不得掩盖原始错误。 */
async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // 见注释：保留原始错误。
  }
}

// 简单查询协议不支持绑定参数。内联进束语句的标识符必须落在安全字符集内
// （字母、数字、连字符、下划线），不含引号、空白与分号，杜绝注入面；产品
// 标识符为 UUIDv7，集成测试夹具使用可读 ID，两者都满足该形态。
const INLINE_SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function quoteIdentifierForInlineSql(value: string, subject: string): string {
  if (!INLINE_SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new DomainError("MALFORMED_IDENTIFIER", `${subject}标识符格式非法，无法构造束语句。`);
  }
  return `'${value}'`;
}

/** 简单查询协议的多语句束按语句顺序各返回一个结果；返回非数组说明协议假设被破坏。 */
async function executeSimpleStatementBundle(
  client: PoolClient,
  sql: string,
): Promise<readonly QueryResult[]> {
  const result: unknown = await client.query(sql);
  if (!Array.isArray(result)) {
    throw new Error("多语句束必须在简单查询协议下返回结果数组");
  }
  return result as QueryResult[];
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
  const queueTiming = retryQueueTiming({
    runStatus,
    retryMode: control.retry_mode,
    retryableRunnerFailure: isRetryableRunnerFailure(expiration.resultCode),
    attemptNumber: control.attempt_number,
    eligibleAt: recordedAt,
    queueTimeoutMs: control.queue_timeout_ms,
  });
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
     terminal_reason_code = $3, held_round = $4, queue_deadline_at = $5, updated_at = $6,
     version = version + 1
     WHERE id = $7 AND status IN ('assigned', 'running')`,
    [
      runStatus,
      runStatus === "queued" ? null : attemptStatus,
      runStatus === "queued" ? null : expiration.resultCode,
      queueTiming.heldRound,
      queueTiming.queueDeadlineAt,
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

async function findAttemptControl(
  client: PoolClient,
  attemptId: string,
  lock = false,
): Promise<AttemptControlRow | undefined> {
  const result = await client.query<AttemptControlRow>(
    `SELECT a.id, a.execution_run_id, a.runner_id, a.attempt_number, a.status,
     r.status AS run_status, r.cancel_requested_at AS run_cancel_requested_at,
     b.retry_limit, b.retry_mode, b.queue_timeout_ms, b.id AS batch_id, b.project_id,
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

type ClaimLeaseSeed = { id: string; eventId: string; tokenHash: string; tokenEncrypted: string };

/**
 * 批量将候选 assignment 置为 claimed：单条集合 UPDATE 替代逐行更新。
 * 逐行守卫保留在条件里（仍为 pending、批次未请求取消），实际成功集合经
 * RETURNING 回传；候选行已被调用方的 FOR UPDATE 锁定，无竞争窗口。
 */
async function bulkClaimAssignments(
  client: PoolClient,
  input: { candidateIds: string[]; now: string },
): Promise<string[]> {
  if (input.candidateIds.length === 0) return [];
  const result = await client.query<{ id: string }>(
    `UPDATE assignments a
     SET status = 'claimed', claimed_at = $2, updated_at = $2, version = version + 1
     FROM unnest($1::text[]) AS s(id)
     WHERE a.id = s.id AND a.status = 'pending'
       AND EXISTS (SELECT 1 FROM run_batches b
                   WHERE b.id = a.batch_id AND b.cancel_requested_at IS NULL)
     RETURNING a.id`,
    [input.candidateIds, input.now],
  );
  return result.rows.map((row) => row.id);
}

/**
 * 批量写入领取的从属副作用：租约、执行/尝试状态迁移与状态事件各用一条
 * 集合语句完成。顺序不承载语义（租约种子与 assignment 的配对在调用方生成），
 * 因此集合写入与逐行写入的可观察结果一致。
 */
async function persistBulkClaimSideEffects(
  client: PoolClient,
  input: {
    pairs: Array<{ assignment: AssignmentRow; seed: ClaimLeaseSeed }>;
    runnerId: string;
    now: string;
    leaseExpiresAt: string;
  },
): Promise<void> {
  if (input.pairs.length === 0) return;
  await client.query(
    `INSERT INTO assignment_leases
     (id, assignment_id, runner_id, token_hash, token_encrypted, status, version, expires_at, renewed_at, created_at)
     SELECT s.lease_id, s.assignment_id, $1, s.token_hash, s.token_encrypted, 'active', 1, $2, $3, $3
     FROM unnest($4::text[], $5::text[], $6::text[], $7::text[])
       AS s(lease_id, assignment_id, token_hash, token_encrypted)`,
    [
      input.runnerId,
      input.leaseExpiresAt,
      input.now,
      input.pairs.map((pair) => pair.seed.id),
      input.pairs.map((pair) => pair.assignment.id),
      input.pairs.map((pair) => pair.seed.tokenHash),
      input.pairs.map((pair) => pair.seed.tokenEncrypted),
    ],
  );
  await client.query(
    `UPDATE run_attempts SET status = 'running', started_at = COALESCE(started_at, $1), version = version + 1
     WHERE id = ANY($2::text[]) AND status = 'assigned'`,
    [input.now, input.pairs.map((pair) => pair.assignment.attempt_id)],
  );
  await client.query(
    `UPDATE execution_runs SET status = 'running', version = version + 1, updated_at = $1
     WHERE id = ANY($2::text[]) AND status = 'assigned'`,
    [input.now, input.pairs.map((pair) => pair.assignment.execution_run_id)],
  );
  await client.query(
    `INSERT INTO attempt_state_events
     (id, attempt_id, event_type, from_status, to_status, reason_code, actor_type, actor_id, details_json, recorded_at)
     SELECT s.event_id, s.attempt_id, 'assignment.claimed', 'assigned', 'running', NULL, 'runner', $1, s.details, $2
     FROM unnest($3::text[], $4::text[], $5::jsonb[]) AS s(event_id, attempt_id, details)`,
    [
      input.runnerId,
      input.now,
      input.pairs.map((pair) => pair.seed.eventId),
      input.pairs.map((pair) => pair.assignment.attempt_id),
      input.pairs.map((pair) =>
        JSON.stringify({
          assignmentId: pair.assignment.id,
          leaseId: pair.seed.id,
          leaseExpiresAt: input.leaseExpiresAt,
        }),
      ),
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

/**
 * 领取路径专用的批次状态迁移：领取只会把 run 置为 running，聚合结果由
 * execution_runs 的活跃状态唯一确定，无需通用“先锁再聚合”的完整流程。
 * 单条语句内完成批次行锁定、活跃状态聚合、条件迁移与事件写入，使批次行锁
 * 只持有单语句执行窗口；同批次并发领取不再跨多条语句互相排队。
 * 终态批次（含并发取消）不会被迁移，语义与聚合路径一致。
 */
async function markBatchActiveOnClaim(
  client: Pick<PoolClient, "query">,
  batchId: string,
  updatedAt: string,
  eventId: string,
): Promise<void> {
  await client.query(
    `WITH presence AS (
       SELECT EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'running') AS running,
              EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'assigned') AS assigned,
              EXISTS(SELECT 1 FROM execution_runs WHERE batch_id = $1 AND status = 'queued') AS queued
     ),
     locked AS (
       SELECT status FROM run_batches WHERE id = $1 FOR UPDATE
     ),
     decision AS (
       SELECT locked.status AS old_status,
              CASE
                WHEN locked.status IN ('succeeded', 'failed', 'cancelled') THEN NULL
                WHEN presence.running THEN 'running'
                WHEN presence.assigned AND presence.queued THEN 'dispatching'
                WHEN presence.assigned THEN 'scheduled'
                ELSE NULL
              END AS new_status
       FROM locked, presence
     ),
     transition AS (
       UPDATE run_batches
       SET status = decision.new_status, updated_at = $2, version = version + 1
       FROM decision
       WHERE run_batches.id = $1
         AND decision.new_status IS NOT NULL
         AND decision.new_status <> decision.old_status
       RETURNING decision.old_status, decision.new_status, run_batches.version
     )
     INSERT INTO run_batch_status_events
       (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
     SELECT $3, $1, transition.old_status, transition.new_status, transition.version,
            'assignment.claimed', $2
     FROM transition`,
    [batchId, updatedAt, eventId],
  );
}

async function updateBatchStatus(
  client: PoolClient,
  batchId: string,
  updatedAt: string,
  eventId: string,
  reason: string,
): Promise<RunBatchStatus> {
  // 必须先串行化批次行，再在锁内聚合状态；终态批次在锁下短路返回。
  // 若无锁预聚合，最后两个并发完成上报会各自观察到对方尚未提交的 running 态，
  // 双双得出“状态未变”的结论并提交，终态迁移永久丢失（批次卡死在 running）。
  const lockedBatch = await client.query<{
    status: RunBatchStatus;
    version: number;
    retry_mode: "immediate" | "round";
    queue_timeout_ms: number;
    cancel_requested_at: string | null;
  }>(
    "SELECT status, version, retry_mode, queue_timeout_ms, cancel_requested_at FROM run_batches WHERE id = $1 FOR UPDATE",
    [batchId],
  );
  const batchState = lockedBatch.rows[0];
  if (!batchState) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
  if (isTerminalBatchStatus(batchState.status)) return batchState.status;
  // 轮次制下先释放等待下一轮的失败 run，再聚合状态，确保释放的 run 计入批次状态。
  if (!batchState.cancel_requested_at) {
    await advanceRoundIfIdle(
      client,
      batchId,
      batchState.retry_mode,
      batchState.queue_timeout_ms,
      updatedAt,
    );
  }
  const status = await aggregateStoredBatchStatus(
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
  await client.query(
    `INSERT INTO run_batch_status_events
     (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [eventId, batchId, batchState.status, status, batchState.version + 1, reason, updatedAt],
  );
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

// 轮次制：整轮无在途且无未扣留的 queued run 时，把等待下一轮的失败 run 统一释放。
async function advanceRoundIfIdle(
  client: PoolClient,
  batchId: string,
  retryMode: "immediate" | "round",
  queueTimeoutMs: number,
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
  const recoveryBarrier = await client.query<{
    total_steps: string;
    idle_steps: string;
    succeeded_steps: string;
  }>(
    `SELECT COUNT(*) AS total_steps,
            COUNT(*) FILTER (WHERE status = 'idle') AS idle_steps,
            COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded_steps
     FROM run_batch_round_recoveries
     WHERE batch_id = $1 AND after_round = $2`,
    [batchId, nextRoundValue - 1],
  );
  const recoverySteps = recoveryBarrier.rows[0];
  const totalRecoverySteps = Number(recoverySteps?.total_steps ?? 0);
  if (totalRecoverySteps > 0 && Number(recoverySteps?.idle_steps ?? 0) > 0) {
    await client.query(
      `UPDATE run_batch_round_recoveries
       SET status = 'pending', available_at = $1,
           activated_at = COALESCE(activated_at, $1), updated_at = $1
       WHERE batch_id = $2 AND after_round = $3 AND status = 'idle'`,
      [updatedAt, batchId, nextRoundValue - 1],
    );
    return;
  }
  if (totalRecoverySteps > Number(recoverySteps?.succeeded_steps ?? 0)) return;
  await client.query(
    `UPDATE execution_runs SET held_round = 0, queue_deadline_at = $1, updated_at = $2
     WHERE batch_id = $3 AND status = 'queued' AND held_round <= $4`,
    [queueDeadlineAfter(updatedAt, queueTimeoutMs), updatedAt, batchId, nextRoundValue],
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
