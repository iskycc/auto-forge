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

import type { SqliteDatabaseHandle } from "./database";

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

export class SqliteExecutionControlRepository implements ExecutionControlRepository {
  constructor(private readonly handle: SqliteDatabaseHandle) {}

  async claim(
    input: Parameters<ExecutionControlRepository["claim"]>[0],
  ): Promise<ClaimedAssignmentRecord[]> {
    return this.handle.client.transaction(() => {
      const replay = this.claimReplay(input.runnerId, input.requestId);
      if (replay) return replay;
      if (input.availableSlots === 0) return [];
      const candidates = this.handle.client
        .prepare(
          `SELECT * FROM assignments
           WHERE runner_id = ? AND status = 'pending' AND available_at <= ? AND claim_deadline_at > ?
           ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`,
        )
        .all(
          input.runnerId,
          input.now,
          input.now,
          Math.max(input.availableSlots * 8, 8),
        ) as AssignmentRow[];
      const selected = candidates
        .filter((assignment) =>
          matchesAgent(parseSpec(assignment), input.labels, input.capabilities),
        )
        .slice(0, input.availableSlots);
      const claimed: ClaimedAssignmentRecord[] = [];
      for (const [index, assignment] of selected.entries()) {
        const seed = input.leaseSeeds[index];
        if (!seed) break;
        const update = this.handle.client
          .prepare(
            `UPDATE assignments SET status = 'claimed', claimed_at = ?, updated_at = ?, version = version + 1
             WHERE id = ? AND status = 'pending'`,
          )
          .run(input.now, input.now, assignment.id);
        if (update.changes !== 1) continue;
        this.handle.client
          .prepare(
            `INSERT INTO assignment_leases
             (id, assignment_id, runner_id, token_hash, token_encrypted, status, version, expires_at, renewed_at, created_at)
             VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
          )
          .run(
            seed.id,
            assignment.id,
            input.runnerId,
            seed.tokenHash,
            seed.tokenEncrypted,
            input.leaseExpiresAt,
            input.now,
            input.now,
          );
        this.handle.client
          .prepare(
            `UPDATE run_attempts SET status = 'running', started_at = COALESCE(started_at, ?), version = version + 1
             WHERE id = ? AND status = 'assigned'`,
          )
          .run(input.now, assignment.attempt_id);
        this.handle.client
          .prepare(
            `UPDATE execution_runs SET status = 'running', version = version + 1, updated_at = ?
             WHERE id = ? AND status = 'assigned'`,
          )
          .run(input.now, assignment.execution_run_id);
        this.appendAttemptEvent({
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
        this.updateBatchStatus(assignment.batch_id, input.now);
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
        this.saveClaimRequest(
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
    })();
  }

  async renewLease(
    input: Parameters<ExecutionControlRepository["renewLease"]>[0],
  ): ReturnType<ExecutionControlRepository["renewLease"]> {
    return this.handle.client.transaction(() => {
      const lease = this.requiredLease(input.leaseId);
      if (lease.runner_id !== input.runnerId || lease.token_hash !== input.tokenHash) {
        throw new DomainError("LEASE_AUTH_REJECTED", "租约凭据无效。");
      }
      if (lease.status !== "active" || lease.expires_at <= input.now) {
        throw new DomainError("LEASE_EXPIRED", "租约已过期或失效。");
      }
      if (lease.version !== input.expectedVersion) {
        throw new DomainError("LEASE_VERSION_CONFLICT", "租约版本已变化。");
      }
      const assignment = this.requiredAssignment(lease.assignment_id);
      const instruction = assignment.cancel_requested_at
        ? ("cancel" as const)
        : ("continue" as const);
      const nextVersion = lease.version + 1;
      this.handle.client
        .prepare(
          `UPDATE assignment_leases SET version = ?, expires_at = ?, renewed_at = ?
           WHERE id = ? AND status = 'active' AND version = ?`,
        )
        .run(nextVersion, input.expiresAt, input.now, input.leaseId, input.expectedVersion);
      this.handle.client
        .prepare(
          `UPDATE assignments SET status = CASE WHEN status = 'claimed' THEN 'running' ELSE status END,
           updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('claimed', 'running')`,
        )
        .run(input.now, assignment.id);
      return {
        schemaVersion: 1 as const,
        acceptedAt: input.now,
        leaseVersion: nextVersion,
        expiresAt: input.expiresAt,
        instruction,
      };
    })();
  }

  async completeAttempt(
    input: Parameters<ExecutionControlRepository["completeAttempt"]>[0],
  ): Promise<CompleteAttemptResponse> {
    return this.handle.client.transaction(() => {
      const existing = this.handle.client
        .prepare(
          "SELECT result_digest, response_json FROM attempt_completion_receipts WHERE attempt_id = ?",
        )
        .get(input.attemptId) as { result_digest: string; response_json: string } | undefined;
      if (existing) {
        if (existing.result_digest !== input.resultDigest) {
          throw new DomainError("ATTEMPT_COMPLETION_CONFLICT", "该执行尝试已收到不同的完成结果。");
        }
        return {
          ...completeAttemptResponseSchema.parse(JSON.parse(existing.response_json)),
          disposition: "duplicate" as const,
        };
      }

      const control = this.requiredAttemptControl(input.attemptId);
      const assignment = this.assignmentForAttempt(input.attemptId);
      const lease = assignment ? this.latestLeaseForAssignment(assignment.id) : undefined;
      if (
        !assignment ||
        !lease ||
        lease.runner_id !== input.runnerId ||
        lease.token_hash !== input.leaseTokenHash
      ) {
        throw new DomainError("LEASE_AUTH_REJECTED", "完成上报的租约凭据无效。");
      }
      const currentAttempt = this.handle.client
        .prepare("SELECT MAX(attempt_number) AS value FROM run_attempts WHERE execution_run_id = ?")
        .get(control.execution_run_id) as { value: number };
      const isLate =
        lease.status !== "active" ||
        lease.expires_at <= input.acceptedAt ||
        currentAttempt.value !== control.attempt_number ||
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
        this.persistCompletion(
          control,
          assignment,
          lease,
          effectiveResult,
          input,
          decision.runStatus,
        );
      }
      this.handle.client
        .prepare(
          `INSERT INTO attempt_completion_receipts
           (attempt_id, completion_id, result_digest, response_json, accepted_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.attemptId,
          input.completionId,
          input.resultDigest,
          JSON.stringify(response),
          input.acceptedAt,
        );
      return response;
    })();
  }

  async reconcile(
    input: Parameters<ExecutionControlRepository["reconcile"]>[0],
  ): Promise<ReconcileAttemptsResponse> {
    const decisions = input.request.attempts.map((local) => {
      const control = this.findAttemptControl(local.attemptId);
      if (!control || control.runner_id !== input.runnerId) {
        return { attemptId: local.attemptId, action: "clean" as const };
      }
      if (isTerminalRunStatus(control.run_status) || isTerminalAttemptStatus(control.status)) {
        return { attemptId: local.attemptId, action: "clean" as const };
      }
      const assignment = this.assignmentForAttempt(local.attemptId);
      const lease = assignment ? this.activeLeaseForAssignment(assignment.id) : undefined;
      const action =
        assignment?.cancel_requested_at || control.run_cancel_requested_at
          ? "cancel"
          : lease && lease.expires_at > input.now
            ? "continue"
            : "cancel";
      return {
        attemptId: local.attemptId,
        action,
        acknowledgedLogSequence: this.logWatermarks(local.attemptId),
      };
    });
    return reconcileAttemptsResponseSchema.parse({ schemaVersion: 1, decisions });
  }

  async resolveAttemptInput(
    input: Parameters<ExecutionControlRepository["resolveAttemptInput"]>[0],
  ): ReturnType<ExecutionControlRepository["resolveAttemptInput"]> {
    const row = this.handle.client
      .prepare(
        `SELECT s.object_key, s.size_bytes, s.sha256, l.token_hash, l.status AS lease_status,
                l.expires_at, a.runner_id
         FROM assignments a
         JOIN assignment_leases l ON l.assignment_id = a.id
         JOIN execution_runs r ON r.id = a.execution_run_id
         JOIN case_definitions d ON d.id = r.case_definition_id
         JOIN case_sources s ON s.id = d.source_id
         WHERE a.attempt_id = ? AND s.id = ?
         ORDER BY l.created_at DESC LIMIT 1`,
      )
      .get(input.attemptId, input.inputId) as
      | {
          object_key: string;
          size_bytes: number;
          sha256: string;
          token_hash: string;
          lease_status: string;
          expires_at: string;
          runner_id: string;
        }
      | undefined;
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
    return this.handle.client.transaction(() => {
      const active = this.handle.client
        .prepare(
          `SELECT l.id AS lease_id, a.id AS assignment_id, a.attempt_id
           FROM assignment_leases l JOIN assignments a ON a.id = l.assignment_id
           WHERE l.status = 'active' AND l.expires_at <= ? ORDER BY l.expires_at LIMIT ?`,
        )
        .all(input.now, input.limit) as Array<{
        lease_id: string;
        assignment_id: string;
        attempt_id: string;
      }>;
      const unclaimed = this.handle.client
        .prepare(
          `SELECT id AS assignment_id, attempt_id FROM assignments
           WHERE status = 'pending' AND claim_deadline_at <= ? ORDER BY claim_deadline_at LIMIT ?`,
        )
        .all(input.now, Math.max(0, input.limit - active.length)) as Array<{
        assignment_id: string;
        attempt_id: string;
      }>;
      let recovered = 0;
      for (const expired of [...active, ...unclaimed]) {
        const eventId = input.eventIds[recovered];
        if (!eventId) break;
        if ("lease_id" in expired) {
          this.handle.client
            .prepare(
              "UPDATE assignment_leases SET status = 'expired' WHERE id = ? AND status = 'active'",
            )
            .run(expired.lease_id);
        }
        if (this.expireAttempt(expired.assignment_id, expired.attempt_id, input.now, eventId)) {
          recovered += 1;
        }
      }
      return recovered;
    })();
  }

  async cancelBatch(
    input: Parameters<ExecutionControlRepository["cancelBatch"]>[0],
  ): Promise<number> {
    return this.handle.client.transaction(() => {
      const runs = this.handle.client
        .prepare(
          "SELECT id FROM execution_runs WHERE batch_id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')",
        )
        .all(input.batchId) as Array<{ id: string }>;
      this.handle.client
        .prepare("UPDATE run_batches SET cancel_requested_at = ?, updated_at = ? WHERE id = ?")
        .run(input.requestedAt, input.requestedAt, input.batchId);
      let changed = 0;
      for (const [index, run] of runs.entries()) {
        const eventId = input.eventIds[index];
        if (!eventId) break;
        changed += this.cancelRunWithinTransaction({ ...input, runId: run.id, eventId }) ? 1 : 0;
      }
      this.updateBatchStatus(input.batchId, input.requestedAt);
      return changed;
    })();
  }

  async cancelRun(input: Parameters<ExecutionControlRepository["cancelRun"]>[0]): Promise<boolean> {
    return this.handle.client.transaction(() => this.cancelRunWithinTransaction(input))();
  }

  private persistCompletion(
    control: AttemptControlRow,
    assignment: AssignmentRow,
    lease: LeaseRow,
    result: CompletionResult,
    input: Parameters<ExecutionControlRepository["completeAttempt"]>[0],
    runStatus: "queued" | "succeeded" | "failed" | "cancelled",
  ): void {
    this.handle.client
      .prepare(
        `UPDATE run_attempts SET status = ?, outcome = ?, result_code = ?, result_summary = ?,
         completion_digest = ?, finished_at = ?, version = version + 1
         WHERE id = ? AND status IN ('assigned', 'running')`,
      )
      .run(
        result.status,
        result.status,
        result.resultCode,
        result.summary,
        input.resultDigest,
        input.acceptedAt,
        input.attemptId,
      );
    this.handle.client
      .prepare(
        `UPDATE assignments SET status = 'completed', completed_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND status IN ('claimed', 'running')`,
      )
      .run(input.acceptedAt, input.acceptedAt, assignment.id);
    this.handle.client
      .prepare(
        "UPDATE assignment_leases SET status = 'released' WHERE id = ? AND status = 'active'",
      )
      .run(lease.id);
    this.handle.client
      .prepare(
        `UPDATE execution_runs SET status = ?, terminal_outcome = ?, assigned_runner_id = ?,
         updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('assigned', 'running')`,
      )
      .run(
        runStatus,
        runStatus === "queued" ? null : result.status,
        runStatus === "queued" ? null : control.runner_id,
        input.acceptedAt,
        control.execution_run_id,
      );
    this.persistCompletionMetadata(input.attemptId, result, input.acceptedAt);
    this.appendAttemptEvent({
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
    this.updateBatchStatus(control.batch_id, input.acceptedAt);
  }

  private persistCompletionMetadata(
    attemptId: string,
    result: CompletionResult,
    recordedAt: string,
  ): void {
    for (const artifact of result.artifacts) {
      this.handle.client
        .prepare(
          `INSERT INTO attempt_artifacts
           (id, attempt_id, relative_path, media_type, size_bytes, sha256, required, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?, ?)
           ON CONFLICT(attempt_id, relative_path) DO NOTHING`,
        )
        .run(
          artifact.artifactId,
          attemptId,
          artifact.relativePath,
          artifact.mediaType,
          artifact.sizeBytes,
          artifact.sha256,
          artifact.required ? 1 : 0,
          recordedAt,
          recordedAt,
        );
    }
    if (result.logWatermarks) {
      for (const stream of ["stdout", "stderr", "agent"] as const) {
        this.handle.client
          .prepare(
            `INSERT INTO attempt_log_watermarks (attempt_id, stream, acknowledged_sequence, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(attempt_id, stream) DO UPDATE SET
             acknowledged_sequence = MAX(acknowledged_sequence, excluded.acknowledged_sequence),
             updated_at = excluded.updated_at`,
          )
          .run(attemptId, stream, result.logWatermarks[stream], recordedAt);
      }
    }
  }

  private expireAttempt(
    assignmentId: string,
    attemptId: string,
    recordedAt: string,
    eventId: string,
  ): boolean {
    const control = this.findAttemptControl(attemptId);
    if (!control || isTerminalAttemptStatus(control.status)) return false;
    const decision = outcomeAfterCompletion({
      outcome: "timed_out",
      attemptNumber: control.attempt_number,
      retryLimit: control.retry_limit,
      cancellationRequested: control.run_cancel_requested_at !== null,
    });
    this.handle.client
      .prepare(
        "UPDATE assignments SET status = 'expired', updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('pending', 'claimed', 'running')",
      )
      .run(recordedAt, assignmentId);
    this.handle.client
      .prepare(
        `UPDATE run_attempts SET status = 'timed_out', outcome = 'timed_out', result_code = 'LEASE_EXPIRED',
         result_summary = 'Assignment lease or claim deadline expired.', finished_at = ?, version = version + 1
         WHERE id = ? AND status IN ('assigned', 'running')`,
      )
      .run(recordedAt, attemptId);
    this.handle.client
      .prepare(
        `UPDATE execution_runs SET status = ?, terminal_outcome = ?, assigned_runner_id = NULL,
         updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('assigned', 'running')`,
      )
      .run(
        decision.runStatus,
        decision.runStatus === "queued" ? null : "timed_out",
        recordedAt,
        control.execution_run_id,
      );
    this.appendAttemptEvent({
      id: eventId,
      attemptId,
      eventType: "lease.expired",
      fromStatus: control.status,
      toStatus: "timed_out",
      actorType: "system",
      details: { retryScheduled: decision.retryScheduled },
      recordedAt,
    });
    this.updateBatchStatus(control.batch_id, recordedAt);
    return true;
  }

  private cancelRunWithinTransaction(input: {
    runId: string;
    actorId: string;
    reason: string;
    eventId: string;
    requestedAt: string;
  }): boolean {
    const run = this.handle.client
      .prepare("SELECT id, batch_id, status FROM execution_runs WHERE id = ?")
      .get(input.runId) as { id: string; batch_id: string; status: string } | undefined;
    if (!run) return false;
    if (isTerminalRunStatus(run.status)) return true;
    const attempt = this.handle.client
      .prepare(
        "SELECT id, status FROM run_attempts WHERE execution_run_id = ? ORDER BY attempt_number DESC LIMIT 1",
      )
      .get(input.runId) as { id: string; status: string } | undefined;
    const assignment = attempt ? this.assignmentForAttempt(attempt.id) : undefined;
    const activelyLeased = assignment ? this.activeLeaseForAssignment(assignment.id) : undefined;
    if (attempt && assignment && activelyLeased && activelyLeased.expires_at > input.requestedAt) {
      this.handle.client
        .prepare(
          "UPDATE execution_runs SET cancel_requested_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(input.requestedAt, input.requestedAt, input.runId);
      this.handle.client
        .prepare(
          "UPDATE assignments SET cancel_requested_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(input.requestedAt, input.requestedAt, assignment.id);
      return true;
    }
    if (assignment) {
      this.handle.client
        .prepare(
          "UPDATE assignments SET status = 'cancelled', cancel_requested_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(input.requestedAt, input.requestedAt, assignment.id);
      this.handle.client
        .prepare(
          "UPDATE assignment_leases SET status = 'revoked' WHERE assignment_id = ? AND status = 'active'",
        )
        .run(assignment.id);
    }
    if (attempt && !isTerminalAttemptStatus(attempt.status)) {
      this.handle.client
        .prepare(
          `UPDATE run_attempts SET status = 'cancelled', outcome = 'cancelled', result_code = 'CANCELLED_BY_USER',
           result_summary = ?, finished_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(input.reason, input.requestedAt, attempt.id);
      this.appendAttemptEvent({
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
    this.handle.client
      .prepare(
        `UPDATE execution_runs SET status = 'cancelled', terminal_outcome = 'cancelled',
         cancel_requested_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(input.requestedAt, input.requestedAt, input.runId);
    this.updateBatchStatus(run.batch_id, input.requestedAt);
    return true;
  }

  private claimReplay(runnerId: string, requestId: string): ClaimedAssignmentRecord[] | null {
    const request = this.handle.client
      .prepare(
        "SELECT response_json FROM assignment_claim_requests WHERE runner_id = ? AND request_id = ?",
      )
      .get(runnerId, requestId) as { response_json: string } | undefined;
    if (!request) return null;
    const references = JSON.parse(request.response_json) as Array<{
      assignmentId: string;
      leaseId: string;
    }>;
    return references.map((reference) => {
      const assignment = this.requiredAssignment(reference.assignmentId);
      const lease = this.requiredLease(reference.leaseId);
      return {
        assignment: mapAssignment(assignment),
        lease: {
          id: lease.id,
          tokenEncrypted: lease.token_encrypted,
          version: lease.version,
          expiresAt: lease.expires_at,
        },
      };
    });
  }

  private saveClaimRequest(
    runnerId: string,
    requestId: string,
    references: Array<{ assignmentId: string; leaseId: string }>,
    createdAt: string,
  ): void {
    this.handle.client
      .prepare(
        "INSERT INTO assignment_claim_requests (runner_id, request_id, response_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(runnerId, requestId, JSON.stringify(references), createdAt);
  }

  private requiredAssignment(assignmentId: string): AssignmentRow {
    const row = this.handle.client
      .prepare("SELECT * FROM assignments WHERE id = ?")
      .get(assignmentId) as AssignmentRow | undefined;
    if (!row) throw new DomainError("ASSIGNMENT_NOT_FOUND", "指定的 assignment 不存在。");
    return row;
  }

  private assignmentForAttempt(attemptId: string): AssignmentRow | undefined {
    return this.handle.client
      .prepare("SELECT * FROM assignments WHERE attempt_id = ?")
      .get(attemptId) as AssignmentRow | undefined;
  }

  private requiredLease(leaseId: string): LeaseRow {
    const row = this.handle.client
      .prepare("SELECT * FROM assignment_leases WHERE id = ?")
      .get(leaseId) as LeaseRow | undefined;
    if (!row) throw new DomainError("LEASE_NOT_FOUND", "指定的租约不存在。");
    return row;
  }

  private activeLeaseForAssignment(assignmentId: string): LeaseRow | undefined {
    return this.handle.client
      .prepare(
        "SELECT * FROM assignment_leases WHERE assignment_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      )
      .get(assignmentId) as LeaseRow | undefined;
  }

  private latestLeaseForAssignment(assignmentId: string): LeaseRow | undefined {
    return this.handle.client
      .prepare(
        "SELECT * FROM assignment_leases WHERE assignment_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(assignmentId) as LeaseRow | undefined;
  }

  private requiredAttemptControl(attemptId: string): AttemptControlRow {
    const row = this.findAttemptControl(attemptId);
    if (!row) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    return row;
  }

  private findAttemptControl(attemptId: string): AttemptControlRow | undefined {
    return this.handle.client
      .prepare(
        `SELECT a.id, a.execution_run_id, a.runner_id, a.attempt_number, a.status,
         r.status AS run_status, r.cancel_requested_at AS run_cancel_requested_at,
         b.retry_limit, b.id AS batch_id
         FROM run_attempts a JOIN execution_runs r ON r.id = a.execution_run_id
         JOIN run_batches b ON b.id = r.batch_id WHERE a.id = ?`,
      )
      .get(attemptId) as AttemptControlRow | undefined;
  }

  private appendAttemptEvent(input: {
    id: string;
    attemptId: string;
    eventType: string;
    fromStatus?: string;
    toStatus?: string;
    actorType: "user" | "runner" | "system";
    actorId?: string;
    details: Record<string, unknown>;
    recordedAt: string;
  }): void {
    this.handle.client
      .prepare(
        `INSERT INTO attempt_state_events
         (id, attempt_id, event_type, from_status, to_status, actor_type, actor_id, details_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.attemptId,
        input.eventType,
        input.fromStatus ?? null,
        input.toStatus ?? null,
        input.actorType,
        input.actorId ?? null,
        JSON.stringify(input.details),
        input.recordedAt,
      );
  }

  private logWatermarks(attemptId: string): {
    stdout: number;
    stderr: number;
    agent: number;
  } {
    const watermarks = { stdout: -1, stderr: -1, agent: -1 };
    const rows = this.handle.client
      .prepare(
        "SELECT stream, acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id = ?",
      )
      .all(attemptId) as Array<{
      stream: keyof typeof watermarks;
      acknowledged_sequence: number;
    }>;
    for (const row of rows) watermarks[row.stream] = row.acknowledged_sequence;
    return watermarks;
  }

  private updateBatchStatus(batchId: string, updatedAt: string): void {
    const statuses = (
      this.handle.client
        .prepare("SELECT status FROM execution_runs WHERE batch_id = ?")
        .all(batchId) as Array<{
        status: string;
      }>
    ).map((row) => row.status);
    this.handle.client
      .prepare("UPDATE run_batches SET status = ?, updated_at = ? WHERE id = ?")
      .run(aggregateBatchStatus(statuses), updatedAt, batchId);
  }
}

function mapAssignment(row: AssignmentRow): AssignmentDto {
  const executionSpec = parseSpec(row);
  return {
    schemaVersion: 1,
    assignmentId: row.id,
    attemptId: row.attempt_id,
    runnerId: row.runner_id,
    priority: row.priority,
    availableAt: row.available_at,
    claimDeadlineAt: row.claim_deadline_at,
    createdAt: row.created_at,
    executionSpec,
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
