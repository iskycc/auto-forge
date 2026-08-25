import type {
  ClaimAssignmentsInput,
  ClaimAssignmentsResponse,
  CompleteAttemptInput,
  CompletionResult,
  DeclareArtifactsInput,
  LogChunk,
  ReconcileAttemptsInput,
  RenewLeaseInput,
  UploadLogChunksInput,
} from "@autoforge/contracts";
import {
  assessRunnerCompatibility,
  DomainError,
  isRetryableRunnerFailure,
} from "@autoforge/domain";

import type {
  Clock,
  ExecutionControlRepository,
  IdGenerator,
  RunBatchRepository,
  RunBatchSchedulingPort,
  RunnerCredentialPort,
  JarObjectStorePort,
  RunnerRepository,
  SecretCipherPort,
} from "./ports";
import { assertRunnerAuthenticated } from "./manage-runners";
import { discardableRunnerBatchCacheIds } from "./reconcile-runner-batch-cache";
import { buildRecoverySchedulingEvents } from "./recovery-scheduling-events";
import { resolveAttemptSchedulingContexts } from "./attempt-scheduling-contexts";

const LEASE_DURATION_MS = 45_000;
const RECOVERY_SCAN_LIMIT = 100;
const RECOVERY_MINIMUM_INTERVAL_MS = 1_000;
// 调度日志只渲染 message，失败摘要必须压成单行短文本随消息展示。
const SCHEDULING_SUMMARY_LIMIT = 300;

// 完成结果的中文文案，用于调度事件消息。
const COMPLETION_OUTCOME_LABELS: Record<
  "succeeded" | "failed" | "timed_out" | "cancelled",
  string
> = {
  succeeded: "成功",
  failed: "失败",
  timed_out: "超时",
  cancelled: "已取消",
};

export class ExecutionControlService {
  private recoveryInFlight: Promise<void> | undefined;
  private nextRecoveryAtMs = 0;
  private readonly runnerSchedulingInFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly executions: ExecutionControlRepository,
    private readonly runners: RunnerRepository,
    private readonly credentials: RunnerCredentialPort,
    private readonly credentialCipher: SecretCipherPort,
    private readonly objectStore: JarObjectStorePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly batches: RunBatchRepository,
    private readonly scheduling: RunBatchSchedulingPort,
  ) {}

  async claim(
    runnerId: string,
    credential: string,
    input: ClaimAssignmentsInput,
  ): Promise<ClaimAssignmentsResponse> {
    const runner = await this.authenticateRunner(runnerId, credential);
    const closedBatchIds = await discardableRunnerBatchCacheIds(
      this.batches,
      runnerId,
      input.cachedBatchIds ?? [],
    );
    if (!assessRunnerCompatibility(runner).compatible) {
      throw new DomainError(
        "RUNNER_INCOMPATIBLE",
        "当前执行机的协议、平台或执行能力与控制面不兼容。",
      );
    }
    if (runner.state === "draining") {
      return {
        schemaVersion: 1,
        requestId: input.requestId,
        assignments: [],
        retryAfterMs: Math.max(1_000, input.waitSeconds * 1_000),
        closedBatchIds,
      };
    }
    if (!this.credentialCipher.available) {
      throw new DomainError(
        "SECRET_CIPHER_UNAVAILABLE",
        "领取执行任务前必须配置用于保护租约凭据的平台主密钥。",
      );
    }
    const now = this.clock.now();
    await this.recoverExpiredAttempts(now);
    // 同一 claim 请求内完成“回收 -> 重调度 -> 领取”，避免等待下一次
    // heartbeat。每次 claim 都补调度，上次调度失败后也能幂等恢复。
    await this.scheduleForRunner(runnerId, input.availableSlots);
    const leaseSeeds = Array.from({ length: input.availableSlots }, () => {
      const id = this.ids.next();
      const token = this.credentials.issue();
      return {
        id,
        eventId: this.ids.next(),
        token,
        tokenHash: this.credentials.hash(token),
        tokenEncrypted: this.credentialCipher.encrypt(token, leaseTokenPurpose(id)),
      };
    });
    const claimed = await this.executions.claim({
      runnerId,
      requestId: input.requestId,
      availableSlots: input.availableSlots,
      labels: unique(input.labels),
      capabilities: unique(input.capabilities),
      leaseSeeds: leaseSeeds.map((seed) => ({
        id: seed.id,
        eventId: seed.eventId,
        tokenHash: seed.tokenHash,
        tokenEncrypted: seed.tokenEncrypted,
      })),
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
    });
    // assignment DTO 不携带 batchId/executionRunId，逐条反查调度上下文后写入领取事件。
    if (claimed.length > 0) {
      const recordedAt = this.clock.now().toISOString();
      const events: Array<{
        id: string;
        batchId: string;
        runnerId?: string;
        executionRunId?: string;
        attemptId?: string;
        eventType: "attempt_claimed";
        message: string;
        recordedAt: string;
      }> = [];
      const contexts = await resolveAttemptSchedulingContexts(
        this.executions,
        claimed.map((record) => record.assignment.attemptId),
      );
      for (const record of claimed) {
        const context = contexts.get(record.assignment.attemptId);
        if (!context) continue;
        events.push({
          id: this.ids.next(),
          batchId: context.batchId,
          runnerId,
          executionRunId: context.executionRunId,
          attemptId: record.assignment.attemptId,
          eventType: "attempt_claimed",
          message: `执行机 ${runnerId} 领取任务（attempt ${record.assignment.attemptId}）`,
          recordedAt,
        });
      }
      await this.batches.appendSchedulingEvents(events);
    }
    return {
      schemaVersion: 1,
      requestId: input.requestId,
      assignments: claimed.map((record) => ({
        assignment: record.assignment,
        lease: {
          leaseId: record.lease.id,
          token: this.credentialCipher.decrypt(
            record.lease.tokenEncrypted,
            leaseTokenPurpose(record.lease.id),
          ),
          version: record.lease.version,
          expiresAt: record.lease.expiresAt,
        },
      })),
      retryAfterMs: claimed.length === 0 ? Math.max(500, input.waitSeconds * 1_000) : 100,
      closedBatchIds,
    };
  }

  async renewLease(runnerId: string, credential: string, leaseId: string, input: RenewLeaseInput) {
    const runner = await this.authenticateRunner(runnerId, credential);
    const now = this.clock.now();
    const renewed = await this.executions.renewLease({
      runnerId,
      leaseId,
      tokenHash: this.credentials.hash(input.leaseToken),
      expectedVersion: input.leaseVersion,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
    });
    return runner.state === "draining" && renewed.instruction === "continue"
      ? { ...renewed, instruction: "drain" as const }
      : renewed;
  }

  async complete(
    runnerId: string,
    credential: string,
    attemptId: string,
    input: CompleteAttemptInput,
  ) {
    await this.authenticateRunner(runnerId, credential);
    const result = await this.enrichSummaryFromFailureLog(attemptId, input.result);
    const response = await this.executions.completeAttempt({
      runnerId,
      attemptId,
      completionId: input.completionId,
      leaseTokenHash: this.credentials.hash(input.leaseToken),
      resultDigest: this.credentials.hash(JSON.stringify(result)),
      result,
      eventId: this.ids.next(),
      auditEventId: this.ids.next(),
      acceptedAt: this.clock.now().toISOString(),
    });
    // 仅在状态机接受该完成上报时记录事件；duplicate/late 不重复写入。
    // 事件使用富化后的 result（含日志尾部提取的失败原因），否则调度日志看不到失败原因。
    if (response.disposition === "accepted") {
      await this.appendAttemptCompletionEvents(attemptId, result, response.retryScheduled);
    }
    return response;
  }

  // 从日志尾部提取权威失败原因，无论是否已有结构化 TestNG 结果都不生成“类#方法执行失败”
  // 占位摘要。优先解析 adapter 的机器可读标记；旧日志没有标记时再扫描异常行。
  // 找不到时保留 Runner 原始摘要，日志读取失败也不得阻断完成上报的接受。
  private async enrichSummaryFromFailureLog(
    attemptId: string,
    result: CompletionResult,
  ): Promise<CompletionResult> {
    if (result.status !== "failed" && result.status !== "timed_out") return result;
    // 重启/取消协调重放的结果码：日志属于被强杀的旧进程，从中提取的"失败原因"
    // 会误导排查；保留上报方自带的摘要，让原因码作为 blocked 的主展示信息。
    if (RECONCILED_COMPLETION_RESULT_CODES.has(result.resultCode ?? "")) return result;
    // adapter 的失败标记打在 stdout，优先于 stderr。
    for (const stream of ["stdout", "stderr"] as const) {
      const line = adapterFailureLine(await this.readFailureMarkerWindow(attemptId, stream));
      if (!line) continue;
      if (result.summary.includes(line)) return result;
      return { ...result, summary: line };
    }
    // 启发式兜底：历史日志没有失败标记，从 stderr/stdout 尾部找异常行。
    for (const stream of ["stderr", "stdout"] as const) {
      const line = lastFailureLine(await this.readLogTail(attemptId, stream));
      if (line) {
        return { ...result, summary: line };
      }
    }
    return result;
  }

  private async readFailureMarkerWindow(
    attemptId: string,
    stream: LogChunk["stream"],
  ): Promise<string> {
    try {
      const matches = await this.executions.listLogChunks({
        attemptId,
        stream,
        afterSequence: -1,
        limit: 500,
        query: "TestCase Run Failed Stack",
      });
      const markerChunk = matches.items.at(-1);
      if (!markerChunk) return "";
      const window = await this.executions.listLogChunks({
        attemptId,
        stream,
        afterSequence: Math.max(-1, markerChunk.sequence - 1),
        limit: 500,
      });
      return window.items.map((chunk) => chunk.content).join("");
    } catch {
      return "";
    }
  }

  private async readLogTail(attemptId: string, stream: LogChunk["stream"]): Promise<string> {
    try {
      const probe = await this.executions.listLogChunks({
        attemptId,
        stream,
        afterSequence: -1,
        limit: 1,
      });
      // Agent 单次日志上限为 64 MiB，协议单块最多 256 KiB；读取最后 500 块既能
      // 覆盖完整的超长失败标记，又保持严格的有界内存使用。
      const fromSequence = Math.max(-1, probe.acknowledgedSequence - 500);
      const { items } = await this.executions.listLogChunks({
        attemptId,
        stream,
        afterSequence: fromSequence,
        limit: 500,
      });
      return items.map((chunk) => chunk.content).join("");
    } catch {
      return "";
    }
  }

  private async appendAttemptCompletionEvents(
    attemptId: string,
    result: CompletionResult,
    retryScheduled: boolean,
  ): Promise<void> {
    const context = await this.executions.resolveAttemptSchedulingContext(attemptId);
    if (!context) return;
    const recordedAt = this.clock.now().toISOString();
    const outcome = result.status;
    const reasonSuffix = outcome === "succeeded" ? "" : completionReasonSuffix(result);
    const failureSummary = outcome === "succeeded" ? "" : compactFailureSummary(result.summary);
    const events: Array<{
      id: string;
      batchId: string;
      runnerId?: string;
      executionRunId?: string;
      attemptId?: string;
      eventType: "attempt_completed" | "run_held_for_round" | "runner_fault_rescheduled";
      message: string;
      payload?: Record<string, unknown>;
      recordedAt: string;
    }> = [
      {
        id: this.ids.next(),
        batchId: context.batchId,
        runnerId: context.runnerId,
        executionRunId: context.executionRunId,
        attemptId,
        eventType: "attempt_completed",
        message: `用例「${context.displayName}」第 ${context.attemptNumber} 次执行${COMPLETION_OUTCOME_LABELS[outcome]}${reasonSuffix}`,
        payload: {
          attemptNumber: context.attemptNumber,
          outcome,
          durationMs: result.durationMs,
          ...(result.resultCode ? { resultCode: result.resultCode } : {}),
          ...(failureSummary ? { summary: failureSummary } : {}),
        },
        recordedAt,
      },
    ];
    if (retryScheduled) {
      const runnerFault = isRetryableRunnerFailure(result.resultCode);
      events.push({
        id: this.ids.next(),
        batchId: context.batchId,
        ...(runnerFault ? { runnerId: context.runnerId } : {}),
        executionRunId: context.executionRunId,
        attemptId,
        eventType: runnerFault ? "runner_fault_rescheduled" : "run_held_for_round",
        message: runnerFault
          ? `执行机异常导致用例「${context.displayName}」自动重新调度（${result.resultCode}）`
          : `该用例已失败，等待下一轮重试${result.resultCode ? `（${result.resultCode}）` : ""}`,
        payload: {
          ...(context.heldRound !== undefined ? { heldRound: context.heldRound } : {}),
          ...(result.resultCode ? { resultCode: result.resultCode } : {}),
          ...(failureSummary ? { summary: failureSummary } : {}),
        },
        recordedAt,
      });
    }
    await this.batches.appendSchedulingEvents(events);
  }

  async reconcile(runnerId: string, credential: string, input: ReconcileAttemptsInput) {
    await this.authenticateRunner(runnerId, credential);
    return this.executions.reconcile({
      runnerId,
      request: input,
      now: this.clock.now().toISOString(),
    });
  }

  async resolveInput(
    runnerId: string,
    credential: string,
    attemptId: string,
    inputId: string,
    leaseToken: string,
  ) {
    await this.authenticateRunner(runnerId, credential);
    if (!leaseToken) throw new DomainError("LEASE_AUTH_REQUIRED", "缺少任务租约凭据。");
    return this.executions.resolveAttemptInput({
      runnerId,
      attemptId,
      inputId,
      leaseTokenHash: this.credentials.hash(leaseToken),
      now: this.clock.now().toISOString(),
    });
  }

  async uploadLogs(
    runnerId: string,
    credential: string,
    attemptId: string,
    input: UploadLogChunksInput,
  ) {
    await this.authenticateRunner(runnerId, credential);
    const leaseTokenHash = this.credentials.hash(input.leaseToken);
    const now = this.clock.now().toISOString();
    return this.executions.appendLogChunks({
      runnerId,
      attemptId,
      leaseTokenHash,
      chunks: redactLogChunks(input.chunks, []),
      receivedAt: now,
    });
  }

  async listLogs(input: {
    attemptId: string;
    stream: "stdout" | "stderr" | "agent";
    afterSequence: number;
    limit: number;
    query?: string;
    recordedAfter?: string;
    recordedBefore?: string;
    projectIds?: readonly string[];
  }) {
    await this.assertAttemptScope(input.attemptId, input.projectIds);
    return this.executions.listLogChunks(input);
  }

  async listAttemptEvents(input: {
    attemptId: string;
    afterEventId?: string;
    limit: number;
    projectIds?: readonly string[];
  }) {
    await this.assertAttemptScope(input.attemptId, input.projectIds);
    return this.executions.listAttemptEvents(input);
  }

  async declareArtifacts(
    runnerId: string,
    credential: string,
    attemptId: string,
    input: DeclareArtifactsInput,
  ) {
    await this.authenticateRunner(runnerId, credential);
    const projectId = await this.requiredAttemptProjectId(attemptId);
    const artifacts = await this.executions.declareArtifacts({
      runnerId,
      attemptId,
      leaseTokenHash: this.credentials.hash(input.leaseToken),
      artifacts: input.artifacts,
      declaredAt: this.clock.now().toISOString(),
    });
    const controlPlanePath = (artifactId: string) =>
      `/api/v1/run-attempts/${encodeURIComponent(attemptId)}/artifacts/${encodeURIComponent(artifactId)}`;
    return {
      schemaVersion: 1 as const,
      artifacts: await Promise.all(
        artifacts.map(async (artifact) => {
          if (artifact.status === "uploaded") {
            return {
              ...artifact,
              uploadPath: controlPlanePath(artifact.artifactId),
              uploadMethod: "control-plane" as const,
            };
          }
          const target = await this.objectStore.prepareArtifactUpload({
            projectId,
            attemptId,
            artifactId: artifact.artifactId,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            mediaType: artifact.mediaType,
          });
          if (target.kind === "control-plane") {
            return {
              ...artifact,
              uploadPath: controlPlanePath(artifact.artifactId),
              uploadMethod: target.kind,
            };
          }
          return {
            ...artifact,
            uploadPath: target.uploadUrl,
            uploadMethod: target.kind,
            finalizePath: `${controlPlanePath(artifact.artifactId)}/finalize`,
          };
        }),
      ),
    };
  }

  async uploadArtifact(input: {
    runnerId: string;
    credential: string;
    attemptId: string;
    artifactId: string;
    leaseToken: string;
    content: AsyncIterable<Uint8Array>;
  }) {
    await this.authenticateRunner(input.runnerId, input.credential);
    const leaseTokenHash = this.credentials.hash(input.leaseToken);
    const declaration = await this.executions.resolveArtifactUpload({
      runnerId: input.runnerId,
      attemptId: input.attemptId,
      artifactId: input.artifactId,
      leaseTokenHash,
      now: this.clock.now().toISOString(),
    });
    if (declaration.status === "uploaded" && declaration.objectKey) return declaration;
    const projectId = await this.requiredAttemptProjectId(input.attemptId);
    const stored = await this.objectStore.putArtifact({
      projectId,
      attemptId: input.attemptId,
      artifactId: input.artifactId,
      sha256: declaration.sha256,
      sizeBytes: declaration.sizeBytes,
      mediaType: declaration.mediaType,
      content: input.content,
    });
    await this.executions.markArtifactUploaded({
      attemptId: input.attemptId,
      artifactId: input.artifactId,
      objectKey: stored.objectKey,
      uploadedAt: this.clock.now().toISOString(),
    });
    return { ...declaration, status: "uploaded" as const, objectKey: stored.objectKey };
  }

  async finalizeArtifactUpload(input: {
    runnerId: string;
    credential: string;
    attemptId: string;
    artifactId: string;
    leaseToken: string;
  }) {
    await this.authenticateRunner(input.runnerId, input.credential);
    const declaration = await this.executions.resolveArtifactUpload({
      runnerId: input.runnerId,
      attemptId: input.attemptId,
      artifactId: input.artifactId,
      leaseTokenHash: this.credentials.hash(input.leaseToken),
      now: this.clock.now().toISOString(),
    });
    if (declaration.status === "uploaded" && declaration.objectKey) return declaration;
    const projectId = await this.requiredAttemptProjectId(input.attemptId);
    const stored = await this.objectStore.verifyArtifactUpload({
      projectId,
      attemptId: input.attemptId,
      artifactId: input.artifactId,
      sha256: declaration.sha256,
      sizeBytes: declaration.sizeBytes,
      mediaType: declaration.mediaType,
    });
    await this.executions.markArtifactUploaded({
      attemptId: input.attemptId,
      artifactId: input.artifactId,
      objectKey: stored.objectKey,
      uploadedAt: this.clock.now().toISOString(),
    });
    return { ...declaration, status: "uploaded" as const, objectKey: stored.objectKey };
  }

  async listArtifacts(attemptId: string, projectIds?: readonly string[]) {
    await this.assertAttemptScope(attemptId, projectIds);
    return this.executions.listArtifacts(attemptId);
  }

  private async assertAttemptScope(
    attemptId: string,
    projectIds: readonly string[] | undefined,
  ): Promise<void> {
    if (!projectIds) return;
    const projectId = await this.executions.resolveAttemptProjectId(attemptId);
    if (!projectId || !projectIds.includes(projectId)) {
      throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    }
  }

  private async requiredAttemptProjectId(attemptId: string): Promise<string> {
    const projectId = await this.executions.resolveAttemptProjectId(attemptId);
    if (!projectId) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
    return projectId;
  }

  async terminateBatch(actorId: string, batchId: string, reason: string): Promise<number> {
    return this.executions.terminateBatch({
      batchId,
      actorId,
      reason,
      eventId: this.ids.next(),
      requestedAt: this.clock.now().toISOString(),
    });
  }

  /**
   * Runner claim 是高频入口。全局恢复扫描按固定窗口合并，避免数百个并发 claim
   * 重复扫描同一批租约并阻塞 Lite 的 Web 事件循环。
   */
  private async recoverExpiredAttempts(now: Date): Promise<void> {
    if (now.getTime() < this.nextRecoveryAtMs) return;
    if (this.recoveryInFlight) return this.recoveryInFlight;
    this.nextRecoveryAtMs = now.getTime() + RECOVERY_MINIMUM_INTERVAL_MS;
    const recovery = (async () => {
      const recovered = await this.executions.recoverExpired({
        now: now.toISOString(),
        eventIds: Array.from({ length: RECOVERY_SCAN_LIMIT }, () => this.ids.next()),
        limit: RECOVERY_SCAN_LIMIT,
      });
      const recoveryEvents = await buildRecoverySchedulingEvents({
        recovered,
        executions: this.executions,
        recordedAt: now.toISOString(),
        nextEventId: () => this.ids.next(),
      });
      if (recoveryEvents.length > 0) {
        await this.batches.appendSchedulingEvents(recoveryEvents);
      }
    })();
    this.recoveryInFlight = recovery;
    try {
      await recovery;
    } finally {
      if (this.recoveryInFlight === recovery) this.recoveryInFlight = undefined;
    }
  }

  /** 同一 Runner 的并发 claim 共用一次补调度；批次数量与可用槽位保持有界。 */
  private async scheduleForRunner(runnerId: string, availableSlots: number): Promise<void> {
    const existing = this.runnerSchedulingInFlight.get(runnerId);
    if (existing) {
      await existing;
      return;
    }
    const batchLimit = Math.min(8, Math.max(1, availableSlots));
    const scheduling = this.scheduling.scheduleForRunner(runnerId, batchLimit);
    this.runnerSchedulingInFlight.set(runnerId, scheduling);
    try {
      await scheduling;
    } finally {
      if (this.runnerSchedulingInFlight.get(runnerId) === scheduling) {
        this.runnerSchedulingInFlight.delete(runnerId);
      }
    }
  }

  async cancelRun(
    actorId: string,
    runId: string,
    reason: string,
    projectIds?: readonly string[],
  ): Promise<void> {
    if (projectIds) {
      const projectId = await this.executions.resolveExecutionRunProjectId(runId);
      if (!projectId || !projectIds.includes(projectId)) {
        throw new DomainError("EXECUTION_RUN_NOT_FOUND", "指定的执行记录不存在。");
      }
    }
    const cancelled = await this.executions.cancelRun({
      runId,
      actorId,
      reason,
      eventId: this.ids.next(),
      requestedAt: this.clock.now().toISOString(),
    });
    if (!cancelled) throw new DomainError("EXECUTION_RUN_NOT_FOUND", "指定的执行记录不存在。");
  }

  private async authenticateRunner(runnerId: string, credential: string) {
    if (!credential) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机凭据。");
    const runner = await this.runners.findByCredentialHash(
      this.credentials.hash(credential),
      this.clock.now().toISOString(),
    );
    const authenticated = assertRunnerAuthenticated(runner, runnerId);
    if (authenticated.protocolVersion !== 1) {
      throw new DomainError("RUNNER_PROTOCOL_UNSUPPORTED", "Runner Protocol 版本不兼容。");
    }
    return authenticated;
  }
}

function leaseTokenPurpose(leaseId: string): string {
  return `runner-lease:${leaseId}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const tokenPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/gi,
  /\b(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
] as const;

export function redactLogContent(content: string, secrets: readonly string[]): string {
  let redacted = content;
  for (const secret of [...new Set(secrets)].filter((value) => value.length >= 3)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  for (const pattern of tokenPatterns) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

function redactLogChunks(
  chunks: UploadLogChunksInput["chunks"],
  secrets: readonly string[],
): UploadLogChunksInput["chunks"] {
  const grouped = new Map<string, typeof chunks>();
  for (const chunk of chunks) {
    const stream = grouped.get(chunk.stream) ?? [];
    stream.push(chunk);
    grouped.set(chunk.stream, stream);
  }
  const result: typeof chunks = [];
  for (const streamChunks of grouped.values()) {
    streamChunks.sort((left, right) => left.sequence - right.sequence);
    const lengths = streamChunks.map((chunk) => chunk.content.length);
    const redacted = redactLogContent(streamChunks.map((chunk) => chunk.content).join(""), secrets);
    let offset = 0;
    for (const [index, chunk] of streamChunks.entries()) {
      const isLast = index === streamChunks.length - 1;
      const end = isLast
        ? redacted.length
        : Math.min(redacted.length, offset + (lengths[index] ?? 0));
      result.push({ ...chunk, content: redacted.slice(offset, end) });
      offset = end;
    }
  }
  return result.sort((left, right) =>
    left.stream === right.stream
      ? left.sequence - right.sequence
      : left.stream.localeCompare(right.stream),
  );
}

// 把多行摘要折叠为单行并限长，避免堆栈撑爆调度日志消息。
function compactFailureSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim().slice(0, SCHEDULING_SUMMARY_LIMIT);
}

// 调度日志只渲染 message，非成功结果必须在消息里带原因码与精简摘要；
// resultCode 缺失（防御）时不追加括号段。
function completionReasonSuffix(result: CompletionResult): string {
  if (!result.resultCode) return "";
  const summary = compactFailureSummary(result.summary);
  return summary ? `（${result.resultCode}：${summary}）` : `（${result.resultCode}）`;
}

// Agent 重启/取消协调后重放的完成结果码；这类尝试的日志由被强杀的旧进程写入，
// 不适合作为失败摘要的启发式来源（参见 enrichSummaryFromFailureLog）。
const RECONCILED_COMPLETION_RESULT_CODES = new Set([
  "AGENT_RESTARTED_DURING_EXECUTION",
  "EXECUTION_CANCELLED_DURING_RECONCILE",
]);

// 新版 adapter 把 UTF-8 摘要编码为 Base64 后输出 ASCII 单行，避免 JVM 控制台编码、
// 换行和日志分块破坏边界；旧版明文标记继续兼容，便于滚动升级 Runner。
const ADAPTER_FAILURE_BASE64_MARKER = "TestCase Run Failed Stack Base64: [";
const ADAPTER_FAILURE_MARKER = "TestCase Run Failed Stack: [";

// 在日志尾部找最后一个失败标记。保留完整内容但折叠换行，避免 power-assert
// 的辅助定位图把状态列撑成多行；不用展示层或调度日志的短摘要上限截断权威摘要。
function adapterFailureLine(content: string): string | null {
  const encoded = enclosedMarkerPayload(content, ADAPTER_FAILURE_BASE64_MARKER, "first");
  const decoded = encoded !== null ? decodeBase64Utf8(encoded) : null;
  const legacy = enclosedMarkerPayload(content, ADAPTER_FAILURE_MARKER, "last");
  return singleLineFailureDescription(decoded ?? legacy ?? "");
}

function enclosedMarkerPayload(
  content: string,
  marker: string,
  closingBracket: "first" | "last",
): string | null {
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const payloadStart = markerIndex + marker.length;
  const payloadEnd =
    closingBracket === "first" ? content.indexOf("]", payloadStart) : content.lastIndexOf("]");
  return payloadEnd >= payloadStart ? content.slice(payloadStart, payloadEnd) : null;
}

function decodeBase64Utf8(encoded: string): string | null {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return null;
  const decoded = bytes.toString("utf8");
  // Buffer 默认会替换非法 UTF-8；往返校验保证损坏标记不会被静默改写。
  return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : null;
}

function singleLineFailureDescription(value: string): string | null {
  const decodedLines = value
    .replace(/&(?:#x20|nbsp);/gi, " ")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const assertionMarker = decodedLines.findIndex((line) => /^Assertion failed\b/i.test(line));
  if (assertionMarker >= 0) {
    const inlineExpression = decodedLines[assertionMarker]!.replace(
      /^Assertion failed\s*:?[\s]*/i,
      "",
    ).trim();
    if (inlineExpression) return inlineExpression.replace(/\s+/g, " ");
    const expression = decodedLines
      .slice(assertionMarker + 1)
      .find((line) => Boolean(line) && !line.includes("|"));
    return expression?.replace(/\s+/g, " ").trim() || null;
  }
  const assertionExpression = decodedLines.find((line) => /^assert\b/i.test(line));
  if (assertionExpression) return assertionExpression.replace(/\s+/g, " ").trim() || null;
  return decodedLines.filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || null;
}

// 在日志尾部找最后一行异常行（优先于堆栈帧行），作为非结构化失败的可读原因。
// Groovy/Spock power-assert 由 assert 表达式和若干缩进诊断行组成；旧版 adapter
// 没有机器标记时也要完整抓取，并折叠为适合表格展示的一行。
function lastFailureLine(content: string): string | null {
  const lines = content.split("\n");
  let stackLine: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    if (/Exception|Error|Caused by/.test(line)) return line;
    if (!stackLine && /^at\s/.test(line)) stackLine = line;
  }
  if (stackLine) return stackLine;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!/^\s*assert\b/.test(lines[index] ?? "")) continue;
    return singleLineFailureDescription(lines[index] ?? "");
  }
  return null;
}
