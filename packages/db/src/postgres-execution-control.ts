import type { ClaimedAssignmentRecord, ExecutionControlRepository } from "@autoforge/application";
import {
  completeAttemptResponseSchema,
  executionSpecSchema,
  reconcileAttemptsResponseSchema,
  type AssignmentDto,
  type CompleteAttemptResponse,
  type CompletionResult,
  type ReconcileAttemptsResponse,
} from "@autoforge/contracts";
import { aggregateBatchStatus, DomainError, outcomeAfterCompletion } from "@autoforge/domain";
import type { PoolClient } from "pg";

import type { PostgresDatabaseHandle } from "./postgres-database";

type AssignmentRow = {
  id: string;
  attempt_id: string;
  execution_run_id: string;
  batch_id: string;
  runner_id: string;
  status: string;
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
  status: string;
  run_status: string;
  retry_limit: number;
  batch_id: string;
  run_cancel_requested_at: string | null;
};

export class PostgresExecutionControlRepository implements ExecutionControlRepository {
  constructor(private readonly handle: PostgresDatabaseHandle) {}

  async claim(
    input: Parameters<ExecutionControlRepository["claim"]>[0],
  ): Promise<ClaimedAssignmentRecord[]> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const replay = await this.claimReplay(client, input.runnerId, input.requestId);
      if (replay) return replay;
      if (input.availableSlots === 0) return [];
      const candidateResult = await client.query<AssignmentRow>(
        `SELECT * FROM assignments
         WHERE runner_id = $1 AND status = 'pending' AND available_at <= $2 AND claim_deadline_at > $2
         ORDER BY priority DESC, created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED LIMIT $3`,
        [input.runnerId, input.now, Math.max(input.availableSlots * 8, 8)],
      );
      const selected = candidateResult.rows
        .filter((assignment) =>
          matchesAgent(parseSpec(assignment), input.labels, input.capabilities),
        )
        .slice(0, input.availableSlots);
      const claimed: ClaimedAssignmentRecord[] = [];
      for (const [index, assignment] of selected.entries()) {
        const seed = input.leaseSeeds[index];
        if (!seed) break;
        const update = await client.query(
          `UPDATE assignments SET status = 'claimed', claimed_at = $1, updated_at = $1, version = version + 1
           WHERE id = $2 AND status = 'pending'`,
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
          details: { assignmentId: assignment.id, leaseId: seed.id },
          recordedAt: input.now,
        });
        await updateBatchStatus(client, assignment.batch_id, input.now);
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
    return this.transaction(async (client) => {
      const existing = await client.query<{ result_digest: string; response_json: string }>(
        "SELECT result_digest, response_json FROM attempt_completion_receipts WHERE attempt_id = $1 FOR UPDATE",
        [input.attemptId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].result_digest !== input.resultDigest) {
          throw new DomainError("ATTEMPT_COMPLETION_CONFLICT", "该执行尝试已收到不同的完成结果。");
        }
        return {
          ...completeAttemptResponseSchema.parse(JSON.parse(existing.rows[0].response_json)),
          disposition: "duplicate" as const,
        };
      }
      const control = await requiredAttemptControl(client, input.attemptId, true);
      const assignment = await assignmentForAttempt(client, input.attemptId);
      const lease = assignment ? await latestLeaseForAssignment(client, assignment.id) : undefined;
      if (
        !assignment ||
        !lease ||
        lease.runner_id !== input.runnerId ||
        lease.token_hash !== input.leaseTokenHash
      ) {
        throw new DomainError("LEASE_AUTH_REJECTED", "完成上报的租约凭据无效。");
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
        schemaVersion: 1,
        completionId: input.completionId,
        acceptedAt: input.acceptedAt,
        disposition: isLate ? "late" : "accepted",
        retryScheduled: false,
      };
      if (!isLate) {
        const effectiveResult = cancellationResult(input.result, control.run_cancel_requested_at);
        const decision = outcomeAfterCompletion({
          outcome: effectiveResult.status,
          attemptNumber: control.attempt_number,
          retryLimit: control.retry_limit,
          cancellationRequested: control.run_cancel_requested_at !== null,
        });
        response.retryScheduled = decision.retryScheduled;
        await persistCompletion(
          client,
          control,
          assignment,
          lease,
          effectiveResult,
          input,
          decision.runStatus,
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
      return response;
    });
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
          acknowledgedLogSequence: await logWatermarks(client, local.attemptId),
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
    const result = await this.handle.pool.query<{
      object_key: string;
      size_bytes: number;
      sha256: string;
      token_hash: string;
      lease_status: string;
      expires_at: string;
      runner_id: string;
    }>(
      `SELECT s.object_key, s.size_bytes, s.sha256, l.token_hash, l.status AS lease_status,
              l.expires_at, a.runner_id
       FROM assignments a
       JOIN assignment_leases l ON l.assignment_id = a.id
       JOIN execution_runs r ON r.id = a.execution_run_id
       JOIN case_definitions d ON d.id = r.case_definition_id
       JOIN case_sources s ON s.id = d.source_id
       WHERE a.attempt_id = $1 AND s.id = $2
       ORDER BY l.created_at DESC LIMIT 1`,
      [input.attemptId, input.inputId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.runner_id !== input.runnerId ||
      row.token_hash !== input.leaseTokenHash ||
      row.lease_status !== "active" ||
      row.expires_at <= input.now
    ) {
      throw new DomainError("ATTEMPT_INPUT_FORBIDDEN", "输入不存在或任务租约无效。");
    }
    return { objectKey: row.object_key, sizeBytes: row.size_bytes, sha256: row.sha256 };
  }

  async recoverExpired(
    input: Parameters<ExecutionControlRepository["recoverExpired"]>[0],
  ): Promise<number> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const active = await client.query<{
        lease_id: string;
        assignment_id: string;
        attempt_id: string;
      }>(
        `SELECT l.id AS lease_id, a.id AS assignment_id, a.attempt_id
         FROM assignment_leases l JOIN assignments a ON a.id = l.assignment_id
         WHERE l.status = 'active' AND l.expires_at <= $1 ORDER BY l.expires_at
         FOR UPDATE OF l SKIP LOCKED LIMIT $2`,
        [input.now, input.limit],
      );
      const remaining = Math.max(0, input.limit - active.rows.length);
      const unclaimed = await client.query<{ assignment_id: string; attempt_id: string }>(
        `SELECT id AS assignment_id, attempt_id FROM assignments
         WHERE status = 'pending' AND claim_deadline_at <= $1 ORDER BY claim_deadline_at
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [input.now, remaining],
      );
      let recovered = 0;
      for (const expired of [...active.rows, ...unclaimed.rows]) {
        const eventId = input.eventIds[recovered];
        if (!eventId) break;
        if ("lease_id" in expired) {
          await client.query(
            "UPDATE assignment_leases SET status = 'expired' WHERE id = $1 AND status = 'active'",
            [expired.lease_id],
          );
        }
        if (
          await expireAttempt(client, expired.assignment_id, expired.attempt_id, input.now, eventId)
        ) {
          recovered += 1;
        }
      }
      return recovered;
    });
  }

  async cancelBatch(
    input: Parameters<ExecutionControlRepository["cancelBatch"]>[0],
  ): Promise<number> {
    await this.handle.ready;
    return this.transaction(async (client) => {
      const runs = await client.query<{ id: string }>(
        "SELECT id FROM execution_runs WHERE batch_id = $1 AND status NOT IN ('succeeded', 'failed', 'cancelled') FOR UPDATE",
        [input.batchId],
      );
      await client.query(
        "UPDATE run_batches SET cancel_requested_at = $1, updated_at = $1 WHERE id = $2",
        [input.requestedAt, input.batchId],
      );
      let changed = 0;
      for (const [index, run] of runs.rows.entries()) {
        const eventId = input.eventIds[index];
        if (!eventId) break;
        changed += (await cancelRun(client, { ...input, runId: run.id, eventId })) ? 1 : 0;
      }
      await updateBatchStatus(client, input.batchId, input.requestedAt);
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

async function persistCompletion(
  client: PoolClient,
  control: AttemptControlRow,
  assignment: AssignmentRow,
  lease: LeaseRow,
  result: CompletionResult,
  input: Parameters<ExecutionControlRepository["completeAttempt"]>[0],
  runStatus: "queued" | "succeeded" | "failed" | "cancelled",
): Promise<void> {
  await client.query(
    `UPDATE run_attempts SET status = $1, outcome = $1, result_code = $2, result_summary = $3,
     completion_digest = $4, finished_at = $5, version = version + 1
     WHERE id = $6 AND status IN ('assigned', 'running')`,
    [
      result.status,
      result.resultCode,
      result.summary,
      input.resultDigest,
      input.acceptedAt,
      input.attemptId,
    ],
  );
  await client.query(
    `UPDATE assignments SET status = 'completed', completed_at = $1, updated_at = $1, version = version + 1
     WHERE id = $2 AND status IN ('claimed', 'running')`,
    [input.acceptedAt, assignment.id],
  );
  await client.query(
    "UPDATE assignment_leases SET status = 'released' WHERE id = $1 AND status = 'active'",
    [lease.id],
  );
  await client.query(
    `UPDATE execution_runs SET status = $1, terminal_outcome = $2, assigned_runner_id = $3,
     updated_at = $4, version = version + 1 WHERE id = $5 AND status IN ('assigned', 'running')`,
    [
      runStatus,
      runStatus === "queued" ? null : result.status,
      runStatus === "queued" ? null : control.runner_id,
      input.acceptedAt,
      control.execution_run_id,
    ],
  );
  await persistCompletionMetadata(client, input.attemptId, result, input.acceptedAt);
  await appendAttemptEvent(client, {
    id: input.eventId,
    attemptId: input.attemptId,
    eventType: "attempt.completed",
    fromStatus: control.status,
    toStatus: result.status,
    actorType: "runner",
    actorId: input.runnerId,
    details: { resultCode: result.resultCode, retryScheduled: runStatus === "queued" },
    recordedAt: input.acceptedAt,
  });
  await updateBatchStatus(client, control.batch_id, input.acceptedAt);
}

async function persistCompletionMetadata(
  client: PoolClient,
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
    for (const stream of ["stdout", "stderr", "agent"] as const) {
      await client.query(
        `INSERT INTO attempt_log_watermarks (attempt_id, stream, acknowledged_sequence, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(attempt_id, stream) DO UPDATE SET
         acknowledged_sequence = GREATEST(attempt_log_watermarks.acknowledged_sequence, EXCLUDED.acknowledged_sequence),
         updated_at = EXCLUDED.updated_at`,
        [attemptId, stream, result.logWatermarks[stream], recordedAt],
      );
    }
  }
}

async function expireAttempt(
  client: PoolClient,
  assignmentId: string,
  attemptId: string,
  recordedAt: string,
  eventId: string,
): Promise<boolean> {
  const control = await findAttemptControl(client, attemptId);
  if (!control || isTerminalAttemptStatus(control.status)) return false;
  const decision = outcomeAfterCompletion({
    outcome: "timed_out",
    attemptNumber: control.attempt_number,
    retryLimit: control.retry_limit,
    cancellationRequested: control.run_cancel_requested_at !== null,
  });
  await client.query(
    "UPDATE assignments SET status = 'expired', updated_at = $1, version = version + 1 WHERE id = $2 AND status IN ('pending', 'claimed', 'running')",
    [recordedAt, assignmentId],
  );
  await client.query(
    `UPDATE run_attempts SET status = 'timed_out', outcome = 'timed_out', result_code = 'LEASE_EXPIRED',
     result_summary = 'Assignment lease or claim deadline expired.', finished_at = $1, version = version + 1
     WHERE id = $2 AND status IN ('assigned', 'running')`,
    [recordedAt, attemptId],
  );
  await client.query(
    `UPDATE execution_runs SET status = $1, terminal_outcome = $2, assigned_runner_id = NULL,
     updated_at = $3, version = version + 1 WHERE id = $4 AND status IN ('assigned', 'running')`,
    [
      decision.runStatus,
      decision.runStatus === "queued" ? null : "timed_out",
      recordedAt,
      control.execution_run_id,
    ],
  );
  await appendAttemptEvent(client, {
    id: eventId,
    attemptId,
    eventType: "lease.expired",
    fromStatus: control.status,
    toStatus: "timed_out",
    actorType: "system",
    details: { retryScheduled: decision.retryScheduled },
    recordedAt,
  });
  await updateBatchStatus(client, control.batch_id, recordedAt);
  return true;
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
  const result = await client.query<{ id: string; batch_id: string; status: string }>(
    "SELECT id, batch_id, status FROM execution_runs WHERE id = $1 FOR UPDATE",
    [input.runId],
  );
  const run = result.rows[0];
  if (!run) return false;
  if (isTerminalRunStatus(run.status)) return true;
  const attemptResult = await client.query<{ id: string; status: string }>(
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
  if (assignment) {
    await client.query(
      "UPDATE assignments SET status = 'cancelled', cancel_requested_at = $1, updated_at = $1, version = version + 1 WHERE id = $2",
      [input.requestedAt, assignment.id],
    );
    await client.query(
      "UPDATE assignment_leases SET status = 'revoked' WHERE assignment_id = $1 AND status = 'active'",
      [assignment.id],
    );
  }
  if (attempt && !isTerminalAttemptStatus(attempt.status)) {
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
      toStatus: "cancelled",
      actorType: "user",
      actorId: input.actorId,
      details: { reason: input.reason },
      recordedAt: input.requestedAt,
    });
  }
  await client.query(
    `UPDATE execution_runs SET status = 'cancelled', terminal_outcome = 'cancelled',
     cancel_requested_at = $1, updated_at = $1, version = version + 1 WHERE id = $2`,
    [input.requestedAt, input.runId],
  );
  await updateBatchStatus(client, run.batch_id, input.requestedAt);
  return true;
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
     b.retry_limit, b.id AS batch_id
     FROM run_attempts a JOIN execution_runs r ON r.id = a.execution_run_id
     JOIN run_batches b ON b.id = r.batch_id WHERE a.id = $1${lock ? " FOR UPDATE OF a, r" : ""}`,
    [attemptId],
  );
  return result.rows[0];
}

async function appendAttemptEvent(
  client: PoolClient,
  input: {
    id: string;
    attemptId: string;
    eventType: string;
    fromStatus?: string;
    toStatus?: string;
    actorType: "user" | "runner" | "system";
    actorId?: string;
    details: Record<string, unknown>;
    recordedAt: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO attempt_state_events
     (id, attempt_id, event_type, from_status, to_status, actor_type, actor_id, details_json, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.attemptId,
      input.eventType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.actorType,
      input.actorId ?? null,
      JSON.stringify(input.details),
      input.recordedAt,
    ],
  );
}

async function logWatermarks(
  client: PoolClient,
  attemptId: string,
): Promise<{ stdout: number; stderr: number; agent: number }> {
  const watermarks = { stdout: -1, stderr: -1, agent: -1 };
  const result = await client.query<{
    stream: keyof typeof watermarks;
    acknowledged_sequence: number;
  }>("SELECT stream, acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id = $1", [
    attemptId,
  ]);
  for (const row of result.rows) watermarks[row.stream] = Number(row.acknowledged_sequence);
  return watermarks;
}

async function updateBatchStatus(
  client: PoolClient,
  batchId: string,
  updatedAt: string,
): Promise<void> {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM execution_runs WHERE batch_id = $1",
    [batchId],
  );
  await client.query("UPDATE run_batches SET status = $1, updated_at = $2 WHERE id = $3", [
    aggregateBatchStatus(result.rows.map((row) => row.status)),
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

function isTerminalRunStatus(status: string): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

function isTerminalAttemptStatus(status: string): boolean {
  return ["succeeded", "failed", "timed_out", "cancelled"].includes(status);
}
