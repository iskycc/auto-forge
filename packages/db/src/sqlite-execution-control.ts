import type { ClaimedAssignmentRecord, ExecutionControlRepository } from "@autoforge/application";
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
  isTerminalRunStatus,
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

import type { SqliteDatabaseHandle } from "./database";

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
  batch_id: string;
  project_id: string;
  run_cancel_requested_at: string | null;
};

type ArtifactRow = {
  id: string;
  attempt_id: string;
  relative_path: string;
  object_key: string | null;
  media_type: string;
  size_bytes: number;
  sha256: string;
  required: number;
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

type AttemptExpirationReason =
  "claim_timeout" | "lease_expired" | "execution_timeout" | "upload_timeout";

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
          details: {
            assignmentId: assignment.id,
            leaseId: seed.id,
            leaseExpiresAt: input.leaseExpiresAt,
          },
          recordedAt: input.now,
        });
        this.updateBatchStatus(assignment.batch_id, input.now, seed.eventId, "assignment.claimed");
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
    const result = this.handle.client.transaction(
      (): { response: CompleteAttemptResponse } | { conflict: true } => {
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
        const existing = this.handle.client
          .prepare(
            "SELECT result_digest, response_json FROM attempt_completion_receipts WHERE attempt_id = ?",
          )
          .get(input.attemptId) as { result_digest: string; response_json: string } | undefined;
        if (existing) {
          if (existing.result_digest !== input.resultDigest) {
            this.appendAttemptEvent({
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
                storedDigest: existing.result_digest,
              },
              recordedAt: input.acceptedAt,
            });
            return { conflict: true };
          }
          return {
            response: {
              ...completeAttemptResponseSchema.parse(JSON.parse(existing.response_json)),
              disposition: "duplicate" as const,
            },
          };
        }

        const currentAttempt = this.handle.client
          .prepare(
            "SELECT MAX(attempt_number) AS value FROM run_attempts WHERE execution_run_id = ?",
          )
          .get(control.execution_run_id) as { value: number };
        const isLate =
          lease.status !== "active" ||
          lease.expires_at <= input.acceptedAt ||
          currentAttempt.value !== control.attempt_number ||
          isTerminalRunStatus(control.run_status);
        const response: CompleteAttemptResponse = {
          schemaVersion: 1 as const,
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
        return { response };
      },
    )();
    if ("conflict" in result) {
      throw new DomainError("ATTEMPT_COMPLETION_CONFLICT", "该执行尝试已收到不同的完成结果。");
    }
    return result.response;
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
    let context: ReturnType<SqliteExecutionControlRepository["authorizedTransferContext"]>;
    try {
      context = this.authorizedTransferContext(input);
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
    const row = this.handle.client
      .prepare(
        `SELECT object_key, size_bytes, sha256
         FROM case_sources
         WHERE id = ?`,
      )
      .get(input.inputId) as
      | {
          object_key: string;
          size_bytes: number;
          sha256: string;
        }
      | undefined;
    if (!row || row.size_bytes !== declaredInput.sizeBytes || row.sha256 !== declaredInput.sha256) {
      throw new DomainError("ATTEMPT_INPUT_INVALID", "执行输入与权威对象元数据不一致。");
    }
    return { objectKey: row.object_key, sizeBytes: row.size_bytes, sha256: row.sha256 };
  }

  async resolveAttemptSecrets(
    input: Parameters<ExecutionControlRepository["resolveAttemptSecrets"]>[0],
  ): ReturnType<ExecutionControlRepository["resolveAttemptSecrets"]> {
    const context = this.authorizedTransferContext(input);
    return this.readAttemptSecrets(context.assignment, "redaction");
  }

  async acquireAttemptSecrets(
    input: Parameters<ExecutionControlRepository["acquireAttemptSecrets"]>[0],
  ): ReturnType<ExecutionControlRepository["acquireAttemptSecrets"]> {
    const context = this.authorizedTransferContext(input);
    return this.readAttemptSecrets(context.assignment, "acquisition");
  }

  async recordAttemptSecretAccess(
    input: Parameters<ExecutionControlRepository["recordAttemptSecretAccess"]>[0],
  ): Promise<void> {
    const project = this.handle.client
      .prepare(
        `SELECT b.project_id FROM run_attempts a
         JOIN execution_runs r ON r.id = a.execution_run_id
         JOIN run_batches b ON b.id = r.batch_id WHERE a.id = ?`,
      )
      .get(input.attemptId) as { project_id: string } | undefined;
    if (!project) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    this.handle.client
      .prepare(
        `INSERT INTO audit_events
         (id, actor_type, actor_id, action, resource_type, resource_id, project_id,
          result, request_id, details_json, recorded_at)
         VALUES (?, 'runner', ?, 'execution_secret.access', 'run_attempt', ?, ?,
                 'succeeded', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runnerId,
        input.attemptId,
        project.project_id,
        input.requestId,
        JSON.stringify({ secretCount: input.secretIds.length, secretIds: input.secretIds }),
        input.recordedAt,
      );
  }

  async appendLogChunks(
    input: Parameters<ExecutionControlRepository["appendLogChunks"]>[0],
  ): ReturnType<ExecutionControlRepository["appendLogChunks"]> {
    return this.handle.client.transaction(() => {
      this.authorizedTransferContext({ ...input, now: input.receivedAt });
      for (const chunk of input.chunks) {
        const existing = this.handle.client
          .prepare(
            `SELECT content, recorded_at FROM attempt_log_chunks
             WHERE attempt_id = ? AND stream = ? AND sequence = ?`,
          )
          .get(input.attemptId, chunk.stream, chunk.sequence) as
          { content: string; recorded_at: string } | undefined;
        if (existing) {
          if (existing.content !== chunk.content || existing.recorded_at !== chunk.recordedAt) {
            throw new DomainError("LOG_CHUNK_CONFLICT", "相同日志序号已保存不同内容。");
          }
          continue;
        }
        this.handle.client
          .prepare(
            `INSERT INTO attempt_log_chunks
             (attempt_id, stream, sequence, content, size_bytes, recorded_at, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.attemptId,
            chunk.stream,
            chunk.sequence,
            chunk.content,
            Buffer.byteLength(chunk.content, "utf8"),
            chunk.recordedAt,
            input.receivedAt,
          );
      }
      return {
        schemaVersion: 1 as const,
        acknowledgedSequence: {
          stdout: this.advanceLogWatermark(input.attemptId, "stdout", input.receivedAt),
          stderr: this.advanceLogWatermark(input.attemptId, "stderr", input.receivedAt),
          agent: this.advanceLogWatermark(input.attemptId, "agent", input.receivedAt),
        },
      };
    })();
  }

  async listLogChunks(
    input: Parameters<ExecutionControlRepository["listLogChunks"]>[0],
  ): ReturnType<ExecutionControlRepository["listLogChunks"]> {
    const attempt = this.handle.client
      .prepare("SELECT result_code FROM run_attempts WHERE id = ?")
      .get(input.attemptId) as { result_code: string | null } | undefined;
    if (!attempt) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    const clauses: string[] = [];
    const parameters: Array<string | number> = [input.attemptId, input.stream, input.afterSequence];
    if (input.query) {
      clauses.push("instr(content, ?) > 0");
      parameters.push(input.query);
    }
    if (input.recordedAfter) {
      clauses.push("recorded_at >= ?");
      parameters.push(input.recordedAfter);
    }
    if (input.recordedBefore) {
      clauses.push("recorded_at <= ?");
      parameters.push(input.recordedBefore);
    }
    parameters.push(input.limit + 1);
    const filters = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
    const rows = this.handle.client
      .prepare(
        `SELECT stream, sequence, content, recorded_at FROM attempt_log_chunks
         WHERE attempt_id = ? AND stream = ? AND sequence > ? ${filters}
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(...parameters) as Array<{
      stream: "stdout" | "stderr" | "agent";
      sequence: number;
      content: string;
      recorded_at: string;
    }>;
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const watermark = this.handle.client
      .prepare(
        "SELECT acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id = ? AND stream = ?",
      )
      .get(input.attemptId, input.stream) as { acknowledged_sequence: number } | undefined;
    return {
      items: page.map((row) => ({
        stream: row.stream,
        sequence: row.sequence,
        content: row.content,
        recordedAt: row.recorded_at,
      })),
      acknowledgedSequence: watermark?.acknowledged_sequence ?? -1,
      ...(hasMore && page.length > 0
        ? { nextSequence: page.at(-1)?.sequence ?? input.afterSequence }
        : {}),
      truncated: attempt.result_code === "LOG_LIMIT_EXCEEDED",
    };
  }

  async resolveAttemptProjectId(attemptId: string): Promise<string | null> {
    const row = this.handle.client
      .prepare(
        `SELECT b.project_id FROM run_attempts a
         JOIN execution_runs r ON r.id = a.execution_run_id
         JOIN run_batches b ON b.id = r.batch_id
         WHERE a.id = ?`,
      )
      .get(attemptId) as { project_id: string } | undefined;
    return row?.project_id ?? null;
  }

  async resolveExecutionRunProjectId(runId: string): Promise<string | null> {
    const row = this.handle.client
      .prepare(
        `SELECT b.project_id FROM execution_runs r
         JOIN run_batches b ON b.id = r.batch_id WHERE r.id = ?`,
      )
      .get(runId) as { project_id: string } | undefined;
    return row?.project_id ?? null;
  }

  async listAttemptEvents(
    input: Parameters<ExecutionControlRepository["listAttemptEvents"]>[0],
  ): ReturnType<ExecutionControlRepository["listAttemptEvents"]> {
    const attempt = this.handle.client
      .prepare("SELECT id FROM run_attempts WHERE id = ?")
      .get(input.attemptId);
    if (!attempt) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    let cursor: { recorded_at: string; id: string } | undefined;
    if (input.afterEventId) {
      cursor = this.handle.client
        .prepare("SELECT recorded_at, id FROM attempt_state_events WHERE attempt_id = ? AND id = ?")
        .get(input.attemptId, input.afterEventId) as typeof cursor;
      if (!cursor) throw new DomainError("ATTEMPT_EVENT_CURSOR_INVALID", "执行事件游标无效。");
    }
    const rows = (
      cursor
        ? this.handle.client
            .prepare(
              `SELECT * FROM attempt_state_events
               WHERE attempt_id = ? AND (recorded_at > ? OR (recorded_at = ? AND id > ?))
               ORDER BY recorded_at, id LIMIT ?`,
            )
            .all(
              input.attemptId,
              cursor.recorded_at,
              cursor.recorded_at,
              cursor.id,
              input.limit + 1,
            )
        : this.handle.client
            .prepare(
              "SELECT * FROM attempt_state_events WHERE attempt_id = ? ORDER BY recorded_at, id LIMIT ?",
            )
            .all(input.attemptId, input.limit + 1)
    ) as AttemptEventRow[];
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return Promise.resolve(
      attemptEventPageSchema.parse({
        items: page.map(mapAttemptEvent),
        ...(hasMore && page.at(-1) ? { nextEventId: page.at(-1)?.id } : {}),
      }),
    );
  }

  async declareArtifacts(
    input: Parameters<ExecutionControlRepository["declareArtifacts"]>[0],
  ): ReturnType<ExecutionControlRepository["declareArtifacts"]> {
    return this.handle.client.transaction(() => {
      this.authorizedTransferContext({ ...input, now: input.declaredAt });
      this.handle.client
        .prepare(
          `UPDATE run_attempts SET upload_started_at = COALESCE(upload_started_at, ?), version = version + 1
           WHERE id = ? AND status = 'running'`,
        )
        .run(input.declaredAt, input.attemptId);
      const result = [];
      for (const artifact of input.artifacts) {
        const existing = this.artifactRow(input.attemptId, artifact.artifactId);
        if (existing) {
          if (!sameArtifact(existing, artifact)) {
            throw new DomainError("ARTIFACT_DECLARATION_CONFLICT", "产物声明与已保存元数据冲突。");
          }
          result.push({ ...artifact, status: existing.status as "declared" | "uploaded" });
          continue;
        }
        this.handle.client
          .prepare(
            `INSERT INTO attempt_artifacts
             (id, attempt_id, relative_path, media_type, size_bytes, sha256, required, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?, ?)`,
          )
          .run(
            artifact.artifactId,
            input.attemptId,
            artifact.relativePath,
            artifact.mediaType,
            artifact.sizeBytes,
            artifact.sha256,
            artifact.required ? 1 : 0,
            input.declaredAt,
            input.declaredAt,
          );
        result.push({ ...artifact, status: "declared" as const });
      }
      return result;
    })();
  }

  async resolveArtifactUpload(
    input: Parameters<ExecutionControlRepository["resolveArtifactUpload"]>[0],
  ): ReturnType<ExecutionControlRepository["resolveArtifactUpload"]> {
    this.authorizedTransferContext(input);
    const row = this.artifactRow(input.attemptId, input.artifactId);
    if (!row) throw new DomainError("ARTIFACT_NOT_FOUND", "指定的产物声明不存在。");
    if (row.status === "rejected") {
      throw new DomainError("ARTIFACT_REJECTED", "指定的产物声明已被拒绝。");
    }
    return { ...mapArtifactRow(row), status: row.status };
  }

  async markArtifactUploaded(
    input: Parameters<ExecutionControlRepository["markArtifactUploaded"]>[0],
  ): Promise<void> {
    const result = this.handle.client
      .prepare(
        `UPDATE attempt_artifacts SET object_key = ?, status = 'uploaded', updated_at = ?
         WHERE id = ? AND attempt_id = ? AND status IN ('declared', 'uploaded')`,
      )
      .run(input.objectKey, input.uploadedAt, input.artifactId, input.attemptId);
    if (result.changes !== 1) throw new DomainError("ARTIFACT_NOT_FOUND", "指定的产物声明不存在。");
  }

  async listArtifacts(attemptId: string): ReturnType<ExecutionControlRepository["listArtifacts"]> {
    const attempt = this.handle.client
      .prepare("SELECT id FROM run_attempts WHERE id = ?")
      .get(attemptId);
    if (!attempt) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    const rows = this.handle.client
      .prepare("SELECT * FROM attempt_artifacts WHERE attempt_id = ? ORDER BY relative_path, id")
      .all(attemptId) as ArtifactRow[];
    return Promise.resolve(rows.map(mapArtifactRow));
  }

  async recoverExpired(
    input: Parameters<ExecutionControlRepository["recoverExpired"]>[0],
  ): Promise<number> {
    return this.handle.client.transaction(() => {
      const queued = this.handle.client
        .prepare(
          `SELECT id, batch_id FROM execution_runs
           WHERE status = 'queued' AND queue_deadline_at IS NOT NULL AND queue_deadline_at <= ?
           ORDER BY queue_deadline_at, id LIMIT ?`,
        )
        .all(input.now, input.limit) as Array<{ id: string; batch_id: string }>;
      let recovered = 0;
      for (const run of queued) {
        const eventId = input.eventIds[recovered];
        if (!eventId) break;
        const update = this.handle.client
          .prepare(
            `UPDATE execution_runs SET status = 'failed', terminal_outcome = 'timed_out',
             terminal_reason_code = 'QUEUE_TIMEOUT', updated_at = ?, version = version + 1
             WHERE id = ? AND status = 'queued' AND queue_deadline_at <= ?`,
          )
          .run(input.now, run.id, input.now);
        if (update.changes !== 1) continue;
        this.updateBatchStatus(run.batch_id, input.now, eventId, "run.queue_timed_out");
        recovered += 1;
      }
      const active = this.handle.client
        .prepare(
          `SELECT l.id AS lease_id, a.id AS assignment_id, a.attempt_id,
             CASE WHEN ra.upload_started_at IS NOT NULL
               AND julianday(ra.upload_started_at) + (r.upload_timeout_ms / 86400000.0) <= julianday(?)
               THEN 'upload_timeout'
             WHEN ra.upload_started_at IS NULL AND ra.started_at IS NOT NULL
               AND julianday(ra.started_at) + (r.execution_timeout_ms / 86400000.0) <= julianday(?)
               THEN 'execution_timeout' ELSE 'lease_expired' END AS expiration_reason
           FROM assignment_leases l
           JOIN assignments a ON a.id = l.assignment_id
           JOIN run_attempts ra ON ra.id = a.attempt_id
           JOIN execution_runs r ON r.id = a.execution_run_id
           WHERE l.status = 'active' AND (
             l.expires_at <= ? OR (
               ra.upload_started_at IS NOT NULL
               AND julianday(ra.upload_started_at) + (r.upload_timeout_ms / 86400000.0) <= julianday(?)
             ) OR (
               ra.upload_started_at IS NULL AND ra.started_at IS NOT NULL
               AND julianday(ra.started_at) + (r.execution_timeout_ms / 86400000.0) <= julianday(?)
             )
           )
           ORDER BY MIN(
             julianday(l.expires_at),
             COALESCE(
               julianday(ra.upload_started_at) + (r.upload_timeout_ms / 86400000.0),
               julianday(ra.started_at) + (r.execution_timeout_ms / 86400000.0)
             )
           )
           LIMIT ?`,
        )
        .all(
          input.now,
          input.now,
          input.now,
          input.now,
          input.now,
          Math.max(0, input.limit - recovered),
        ) as Array<{
        lease_id: string;
        assignment_id: string;
        attempt_id: string;
        expiration_reason: AttemptExpirationReason;
      }>;
      const unclaimed = this.handle.client
        .prepare(
          `SELECT id AS assignment_id, attempt_id, 'claim_timeout' AS expiration_reason FROM assignments
           WHERE status = 'pending' AND claim_deadline_at <= ? ORDER BY claim_deadline_at LIMIT ?`,
        )
        .all(input.now, Math.max(0, input.limit - recovered - active.length)) as Array<{
        assignment_id: string;
        attempt_id: string;
        expiration_reason: AttemptExpirationReason;
      }>;
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
        if (
          this.expireAttempt(
            expired.assignment_id,
            expired.attempt_id,
            input.now,
            eventId,
            expired.expiration_reason,
          )
        ) {
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
      const batch = this.handle.client
        .prepare("SELECT version FROM run_batches WHERE id = ?")
        .get(input.batchId) as { version: number } | undefined;
      if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
      const cancellation = this.handle.client
        .prepare(
          `UPDATE run_batches SET cancel_requested_at = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        )
        .run(input.requestedAt, input.requestedAt, input.batchId, batch.version);
      if (cancellation.changes !== 1) {
        throw new DomainError("RUN_BATCH_VERSION_CONFLICT", "执行批次已被并发修改。");
      }
      let changed = 0;
      for (const [index, run] of runs.entries()) {
        const eventId = input.eventIds[index];
        if (!eventId) break;
        changed += this.cancelRunWithinTransaction({ ...input, runId: run.id, eventId }) ? 1 : 0;
      }
      this.updateBatchStatus(
        input.batchId,
        input.requestedAt,
        input.eventIds[changed] ?? input.batchId,
        "batch.cancelled",
      );
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
    const attemptStatus = transitionRunAttempt(control.status, result.status);
    const assignmentStatus = transitionAssignment(assignment.status, "completed");
    const leaseStatus = transitionLease(lease.status, "released");
    const executionRunStatus = transitionExecutionRun(control.run_status, runStatus);
    this.handle.client
      .prepare(
        `UPDATE run_attempts SET status = ?, outcome = ?, result_code = ?, result_summary = ?,
         completion_digest = ?, duration_ms = ?, testng_result_json = ?, finished_at = ?, version = version + 1
         WHERE id = ? AND status IN ('assigned', 'running')`,
      )
      .run(
        attemptStatus,
        attemptStatus,
        result.resultCode,
        result.summary,
        input.resultDigest,
        result.durationMs,
        result.testNg ? JSON.stringify(result.testNg) : null,
        input.acceptedAt,
        input.attemptId,
      );
    this.handle.client
      .prepare(
        `UPDATE assignments SET status = ?, completed_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND status IN ('claimed', 'running')`,
      )
      .run(assignmentStatus, input.acceptedAt, input.acceptedAt, assignment.id);
    this.handle.client
      .prepare("UPDATE assignment_leases SET status = ? WHERE id = ? AND status = 'active'")
      .run(leaseStatus, lease.id);
    this.handle.client
      .prepare(
        `UPDATE execution_runs SET status = ?, terminal_outcome = ?, assigned_runner_id = ?,
         terminal_reason_code = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND status IN ('assigned', 'running')`,
      )
      .run(
        executionRunStatus,
        executionRunStatus === "queued" ? null : attemptStatus,
        executionRunStatus === "queued" ? null : control.runner_id,
        executionRunStatus === "queued" ? null : result.resultCode,
        input.acceptedAt,
        control.execution_run_id,
      );
    this.persistCompletionMetadata(input.attemptId, result, input.acceptedAt);
    this.appendAttemptEvent({
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
      this.appendRetryAudit({
        id: input.auditEventId ?? input.eventId,
        runId: control.execution_run_id,
        projectId: control.project_id,
        attemptNumber: control.attempt_number,
        resultCode: result.resultCode,
        recordedAt: input.acceptedAt,
      });
    }
    this.updateBatchStatus(control.batch_id, input.acceptedAt, input.eventId, "attempt.completed");
  }

  private authorizedTransferContext(input: {
    runnerId: string;
    attemptId: string;
    leaseTokenHash: string;
    now: string;
  }): { assignment: AssignmentRow } {
    const row = this.handle.client
      .prepare(
        `SELECT a.*, l.token_hash, l.status AS lease_status, l.expires_at
         FROM assignments a JOIN assignment_leases l ON l.assignment_id = a.id
         WHERE a.attempt_id = ? ORDER BY l.created_at DESC LIMIT 1`,
      )
      .get(input.attemptId) as
      | (AssignmentRow & { token_hash: string; lease_status: string; expires_at: string })
      | undefined;
    if (
      !row ||
      row.runner_id !== input.runnerId ||
      row.token_hash !== input.leaseTokenHash ||
      row.lease_status !== "active" ||
      row.expires_at <= input.now
    ) {
      throw new DomainError("ATTEMPT_TRANSFER_FORBIDDEN", "日志或产物传输未获得有效租约授权。");
    }
    return { assignment: row };
  }

  private advanceLogWatermark(
    attemptId: string,
    stream: "stdout" | "stderr" | "agent",
    updatedAt: string,
  ): number {
    const existing = this.handle.client
      .prepare(
        "SELECT acknowledged_sequence FROM attempt_log_watermarks WHERE attempt_id = ? AND stream = ?",
      )
      .get(attemptId, stream) as { acknowledged_sequence: number } | undefined;
    let acknowledged = existing?.acknowledged_sequence ?? -1;
    const sequences = this.handle.client
      .prepare(
        `SELECT sequence FROM attempt_log_chunks
         WHERE attempt_id = ? AND stream = ? AND sequence > ? ORDER BY sequence`,
      )
      .all(attemptId, stream, acknowledged) as Array<{ sequence: number }>;
    for (const row of sequences) {
      if (row.sequence !== acknowledged + 1) break;
      acknowledged = row.sequence;
    }
    this.handle.client
      .prepare(
        `INSERT INTO attempt_log_watermarks (attempt_id, stream, acknowledged_sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(attempt_id, stream) DO UPDATE SET
         acknowledged_sequence = MAX(attempt_log_watermarks.acknowledged_sequence, excluded.acknowledged_sequence),
         updated_at = excluded.updated_at`,
      )
      .run(attemptId, stream, acknowledged, updatedAt);
    return acknowledged;
  }

  private artifactRow(attemptId: string, artifactId: string): ArtifactRow | undefined {
    return this.handle.client
      .prepare("SELECT * FROM attempt_artifacts WHERE attempt_id = ? AND id = ?")
      .get(attemptId, artifactId) as ArtifactRow | undefined;
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
    expirationReason: AttemptExpirationReason,
  ): boolean {
    const control = this.findAttemptControl(attemptId);
    if (!control || isTerminalAttemptStatus(control.status)) return false;
    const decision = outcomeAfterCompletion({
      outcome: "timed_out",
      attemptNumber: control.attempt_number,
      retryLimit: control.retry_limit,
      cancellationRequested: control.run_cancel_requested_at !== null,
    });
    const attemptStatus = transitionRunAttempt(control.status, "timed_out");
    const runStatus = transitionExecutionRun(control.run_status, decision.runStatus);
    const assignment = this.requiredAssignment(assignmentId);
    const assignmentStatus = transitionAssignment(assignment.status, "expired");
    const expiration = attemptExpiration(expirationReason);
    this.handle.client
      .prepare(
        "UPDATE assignments SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('pending', 'claimed', 'running')",
      )
      .run(assignmentStatus, recordedAt, assignmentId);
    this.handle.client
      .prepare(
        `UPDATE run_attempts SET status = 'timed_out', outcome = 'timed_out', result_code = ?,
         result_summary = ?, finished_at = ?, version = version + 1
         WHERE id = ? AND status IN ('assigned', 'running')`,
      )
      .run(expiration.resultCode, expiration.summary, recordedAt, attemptId);
    this.handle.client
      .prepare(
        `UPDATE execution_runs SET status = ?, terminal_outcome = ?, assigned_runner_id = NULL,
         terminal_reason_code = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND status IN ('assigned', 'running')`,
      )
      .run(
        runStatus,
        runStatus === "queued" ? null : attemptStatus,
        runStatus === "queued" ? null : expiration.resultCode,
        recordedAt,
        control.execution_run_id,
      );
    this.appendAttemptEvent({
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
      this.appendRetryAudit({
        id: eventId,
        runId: control.execution_run_id,
        projectId: control.project_id,
        attemptNumber: control.attempt_number,
        resultCode: expiration.resultCode,
        recordedAt,
      });
    }
    this.updateBatchStatus(control.batch_id, recordedAt, eventId, expiration.eventType);
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
      .get(input.runId) as { id: string; batch_id: string; status: ExecutionRunStatus } | undefined;
    if (!run) return false;
    if (isTerminalRunStatus(run.status)) return true;
    const attempt = this.handle.client
      .prepare(
        "SELECT id, status FROM run_attempts WHERE execution_run_id = ? ORDER BY attempt_number DESC LIMIT 1",
      )
      .get(input.runId) as { id: string; status: RunAttemptStatus } | undefined;
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
      const assignmentStatus = transitionAssignment(assignment.status, "cancelled");
      this.handle.client
        .prepare(
          "UPDATE assignments SET status = ?, cancel_requested_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(assignmentStatus, input.requestedAt, input.requestedAt, assignment.id);
      this.handle.client
        .prepare(
          "UPDATE assignment_leases SET status = 'revoked' WHERE assignment_id = ? AND status = 'active'",
        )
        .run(assignment.id);
    }
    if (attempt && !isTerminalAttemptStatus(attempt.status)) {
      const attemptStatus = transitionRunAttempt(attempt.status, "cancelled");
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
        toStatus: attemptStatus,
        actorType: "user",
        actorId: input.actorId,
        details: { reason: input.reason },
        recordedAt: input.requestedAt,
      });
    }
    const runStatus = transitionExecutionRun(run.status, "cancelled");
    this.handle.client
      .prepare(
        `UPDATE execution_runs SET status = ?, terminal_outcome = 'cancelled',
         terminal_reason_code = 'CANCELLED_BY_USER', cancel_requested_at = ?,
         updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(runStatus, input.requestedAt, input.requestedAt, input.runId);
    this.updateBatchStatus(run.batch_id, input.requestedAt, input.eventId, "run.cancelled");
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
         b.retry_limit, b.id AS batch_id, b.project_id
         FROM run_attempts a JOIN execution_runs r ON r.id = a.execution_run_id
         JOIN run_batches b ON b.id = r.batch_id WHERE a.id = ?`,
      )
      .get(attemptId) as AttemptControlRow | undefined;
  }

  private appendRetryAudit(input: {
    id: string;
    runId: string;
    projectId: string;
    attemptNumber: number;
    resultCode: string;
    recordedAt: string;
  }): void {
    this.handle.client
      .prepare(
        `INSERT INTO audit_events
         (id, actor_type, action, resource_type, resource_id, project_id, result, details_json, recorded_at)
         VALUES (?, 'system', 'execution_run.retry_scheduled', 'execution_run', ?, ?, 'succeeded', ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        input.projectId,
        JSON.stringify({ attemptNumber: input.attemptNumber, resultCode: input.resultCode }),
        input.recordedAt,
      );
  }

  private readAttemptSecrets(
    assignment: AssignmentRow,
    purpose: "redaction" | "acquisition",
  ): Array<{
    name: string;
    secretId: string;
    secretVersionId: string;
    valueEncrypted: string;
  }> {
    return parseSpec(assignment).secretReferences.map((reference) => {
      const activePredicate = purpose === "acquisition" ? "AND s.status = 'active'" : "";
      const row = this.handle.client
        .prepare(
          `SELECT v.value_encrypted
           FROM execution_secret_versions v
           JOIN execution_secrets s ON s.id = v.secret_id
           JOIN run_batches b ON b.id = ? AND b.project_id = s.project_id
           WHERE v.id = ? AND v.secret_id = ? ${activePredicate}`,
        )
        .get(assignment.batch_id, reference.secretVersionId, reference.secretId) as
        { value_encrypted: string } | undefined;
      if (!row) {
        throw new DomainError("EXECUTION_SECRET_UNAVAILABLE", "执行所需密文不可用或已撤销。");
      }
      return { ...reference, valueEncrypted: row.value_encrypted };
    });
  }

  private appendAttemptEvent(input: {
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
  }): void {
    this.handle.client
      .prepare(
        `INSERT INTO attempt_state_events
         (id, attempt_id, event_type, from_status, to_status, reason_code, actor_type, actor_id, details_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  private updateBatchStatus(
    batchId: string,
    updatedAt: string,
    eventId: string,
    reason: string,
  ): void {
    const statuses = (
      this.handle.client
        .prepare("SELECT status FROM execution_runs WHERE batch_id = ?")
        .all(batchId) as Array<{
        status: string;
      }>
    ).map((row) => row.status);
    const batch = this.handle.client
      .prepare("SELECT status, version FROM run_batches WHERE id = ?")
      .get(batchId) as { status: RunBatchStatus; version: number } | undefined;
    if (!batch) throw new DomainError("RUN_BATCH_NOT_FOUND", "指定的执行批次不存在。");
    const status = aggregateBatchStatus(statuses);
    transitionRunBatch(batch.status, status);
    const update = this.handle.client
      .prepare(
        `UPDATE run_batches SET status = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(status, updatedAt, batchId, batch.version);
    if (update.changes !== 1) {
      throw new DomainError("RUN_BATCH_VERSION_CONFLICT", "执行批次已被并发修改。");
    }
    if (batch.status !== status) {
      this.handle.client
        .prepare(
          `INSERT INTO run_batch_status_events
           (id, batch_id, from_status, to_status, batch_version, reason, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(eventId, batchId, batch.status, status, batch.version + 1, reason, updatedAt);
    }
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

function attemptExpiration(reason: AttemptExpirationReason): {
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
    recordedAt: row.recorded_at,
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

function sameArtifact(row: ArtifactRow, artifact: ArtifactDeclaration): boolean {
  return (
    row.relative_path === artifact.relativePath &&
    row.media_type === artifact.mediaType &&
    row.size_bytes === artifact.sizeBytes &&
    row.sha256 === artifact.sha256 &&
    Boolean(row.required) === artifact.required
  );
}

function mapArtifactRow(row: ArtifactRow) {
  return {
    artifactId: row.id,
    relativePath: row.relative_path,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    required: Boolean(row.required),
    status: row.status,
    ...(row.object_key ? { objectKey: row.object_key } : {}),
  };
}
