import type {
  AcquireAttemptSecretsInput,
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
import { assessRunnerCompatibility, DomainError } from "@autoforge/domain";

import type {
  Clock,
  ExecutionControlRepository,
  IdGenerator,
  RunBatchRepository,
  RunnerCredentialPort,
  JarObjectStorePort,
  RunnerRepository,
  SecretCipherPort,
} from "./ports";
import { executionSecretPurpose } from "./manage-execution-environments";
import { assertRunnerAuthenticated } from "./manage-runners";
import { buildRecoverySchedulingEvents } from "./recovery-scheduling-events";

const LEASE_DURATION_MS = 45_000;
const RECOVERY_SCAN_LIMIT = 100;
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
  constructor(
    private readonly executions: ExecutionControlRepository,
    private readonly runners: RunnerRepository,
    private readonly credentials: RunnerCredentialPort,
    private readonly cipher: SecretCipherPort,
    private readonly objectStore: JarObjectStorePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly batches: RunBatchRepository,
  ) {}

  async claim(
    runnerId: string,
    credential: string,
    input: ClaimAssignmentsInput,
  ): Promise<ClaimAssignmentsResponse> {
    const runner = await this.authenticateRunner(runnerId, credential);
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
      };
    }
    if (!this.cipher.available) {
      throw new DomainError(
        "SECRET_CIPHER_UNAVAILABLE",
        "领取执行任务前必须配置 AutoForge 主密钥。",
      );
    }
    const now = this.clock.now();
    const recovered = await this.executions.recoverExpired({
      now: now.toISOString(),
      eventIds: Array.from({ length: RECOVERY_SCAN_LIMIT }, () => this.ids.next()),
      limit: RECOVERY_SCAN_LIMIT,
    });
    const recoveryEvents = await buildRecoverySchedulingEvents({
      recovered,
      resolveContext: (attemptId) => this.executions.resolveAttemptSchedulingContext(attemptId),
      recordedAt: now.toISOString(),
      nextEventId: () => this.ids.next(),
    });
    if (recoveryEvents.length > 0) {
      await this.batches.appendSchedulingEvents(recoveryEvents);
    }
    const leaseSeeds = Array.from({ length: input.availableSlots }, () => {
      const id = this.ids.next();
      const token = this.credentials.issue();
      return {
        id,
        eventId: this.ids.next(),
        token,
        tokenHash: this.credentials.hash(token),
        tokenEncrypted: this.cipher.encrypt(token, leaseTokenPurpose(id)),
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
      for (const record of claimed) {
        const context = await this.executions.resolveAttemptSchedulingContext(
          record.assignment.attemptId,
        );
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
          token: this.cipher.decrypt(
            record.lease.tokenEncrypted,
            leaseTokenPurpose(record.lease.id),
          ),
          version: record.lease.version,
          expiresAt: record.lease.expiresAt,
        },
      })),
      retryAfterMs: claimed.length === 0 ? Math.max(500, input.waitSeconds * 1_000) : 100,
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
    let result = enrichFailureSummary(input.result);
    result = await this.enrichSummaryFromFailureLog(attemptId, result, result !== input.result);
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

  // 缺少结构化 TestNG 结果时（如进程非零退出但无报告），从日志尾部提取失败原因拼入摘要，
  // 让批次列表能直接看到失败原因。优先解析 adapter 输出的机器可读失败标记
  // （adapterFailureLine），只有找不到标记且没有结构化摘要时才回退到启发式的异常行扫描。
  // 日志读取失败（如日志库文件缺失）不得阻断完成上报的接受。
  private async enrichSummaryFromFailureLog(
    attemptId: string,
    result: CompletionResult,
    hasStructuredSummary: boolean,
  ): Promise<CompletionResult> {
    if (result.status !== "failed" && result.status !== "timed_out") return result;
    // adapter 的失败标记打在 stdout，优先于 stderr。
    for (const stream of ["stdout", "stderr"] as const) {
      const line = adapterFailureLine(await this.readLogTail(attemptId, stream));
      if (!line) continue;
      if (result.summary.includes(line)) return result;
      return { ...result, summary: `${result.summary} | ${line}`.slice(0, 500) };
    }
    if (hasStructuredSummary) return result;
    // 启发式兜底：历史日志没有失败标记，从 stderr/stdout 尾部找异常行。
    for (const stream of ["stderr", "stdout"] as const) {
      const line = lastFailureLine(await this.readLogTail(attemptId, stream));
      if (line) {
        return { ...result, summary: `${result.summary} | ${line}`.slice(0, 500) };
      }
    }
    return result;
  }

  private async readLogTail(attemptId: string, stream: LogChunk["stream"]): Promise<string> {
    try {
      const probe = await this.executions.listLogChunks({
        attemptId,
        stream,
        afterSequence: -1,
        limit: 1,
      });
      // 只取尾部窗口，避免为找一行堆栈而扫描整段日志。
      const fromSequence = Math.max(-1, probe.acknowledgedSequence - 50);
      const { items } = await this.executions.listLogChunks({
        attemptId,
        stream,
        afterSequence: fromSequence,
        limit: 100,
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
      eventType: "attempt_completed" | "run_held_for_round";
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
      events.push({
        id: this.ids.next(),
        batchId: context.batchId,
        executionRunId: context.executionRunId,
        eventType: "run_held_for_round",
        message: `该用例已失败，等待下一轮重试${result.resultCode ? `（${result.resultCode}）` : ""}`,
        payload: {
          ...(context.heldRound !== undefined ? { heldRound: context.heldRound } : {}),
          ...(result.resultCode ? { resultCode: result.resultCode } : {}),
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
    const encryptedSecrets = await this.executions.resolveAttemptSecrets({
      runnerId,
      attemptId,
      leaseTokenHash,
      now,
    });
    return this.executions.appendLogChunks({
      runnerId,
      attemptId,
      leaseTokenHash,
      chunks: redactLogChunks(
        input.chunks,
        this.decryptSecrets(encryptedSecrets).map(({ value }) => value),
      ),
      receivedAt: now,
    });
  }

  async acquireSecrets(
    runnerId: string,
    credential: string,
    attemptId: string,
    input: AcquireAttemptSecretsInput,
  ) {
    await this.authenticateRunner(runnerId, credential);
    const now = this.clock.now().toISOString();
    const encryptedSecrets = await this.executions.acquireAttemptSecrets({
      runnerId,
      attemptId,
      leaseTokenHash: this.credentials.hash(input.leaseToken),
      now,
    });
    const secrets = this.decryptSecrets(encryptedSecrets);
    await this.executions.recordAttemptSecretAccess({
      id: this.ids.next(),
      runnerId,
      attemptId,
      requestId: input.requestId,
      secretIds: encryptedSecrets.map((secret) => secret.secretId),
      recordedAt: now,
    });
    return {
      schemaVersion: 1 as const,
      requestId: input.requestId,
      secrets,
    };
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

  private decryptSecrets(
    encrypted: Array<{ name: string; secretVersionId: string; valueEncrypted: string }>,
  ): Array<{ name: string; value: string }> {
    if (encrypted.length > 0 && !this.cipher.available) {
      throw new DomainError("SECRET_CIPHER_UNAVAILABLE", "服务端未配置密文主密钥。");
    }
    try {
      return encrypted.map((secret) => ({
        name: secret.name,
        value: this.cipher.decrypt(
          secret.valueEncrypted,
          executionSecretPurpose(secret.secretVersionId),
        ),
      }));
    } catch (error) {
      throw new DomainError("EXECUTION_SECRET_DECRYPT_FAILED", "执行密文无法解密。", {
        cause: error,
      });
    }
  }

  async cancelBatch(actorId: string, batchId: string, reason: string): Promise<number> {
    return this.executions.cancelBatch({
      batchId,
      actorId,
      reason,
      eventIds: Array.from({ length: 10_000 }, () => this.ids.next()),
      requestedAt: this.clock.now().toISOString(),
    });
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
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
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

// 失败或超时时，把首个失败方法定位到摘要，方便在列表页直接看到失败原因。
function enrichFailureSummary(result: CompletionResult): CompletionResult {
  if (result.status !== "failed" && result.status !== "timed_out") return result;
  if (!result.testNg) return result;
  for (const suite of result.testNg.suites) {
    for (const test of suite.tests) {
      for (const clazz of test.classes) {
        for (const method of clazz.methods) {
          if (method.status === "failed") {
            const summary = `${clazz.name}#${method.name} 执行失败`.slice(0, 500);
            return { ...result, summary };
          }
        }
      }
    }
  }
  return result;
}

// TestNG adapter（TestNgResultReporter / CotestTestNgExecutor）在用例失败时向 stdout
// 打印的机器可读标记，格式为 `TestCase Run Failed Stack: [<内容>]` 单行。
// 内容与 adapter 报告中 "Stack Trace:" 之后的第一行一致，即 throwable.toString()
// （异常类名: 消息）。解析该标记优先于启发式的异常行扫描，避免误抓日志尾部的无关异常。
const ADAPTER_FAILURE_MARKER = "TestCase Run Failed Stack: [";

// 在日志内容中找最后一个失败标记行，返回标记内容（trim 后限长 300）；找不到返回 null。
function adapterFailureLine(content: string): string | null {
  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || !line.startsWith(ADAPTER_FAILURE_MARKER) || !line.endsWith("]")) continue;
    return line.slice(ADAPTER_FAILURE_MARKER.length, -1).trim().slice(0, 300);
  }
  return null;
}

// 在日志尾部找最后一行异常行（优先于堆栈帧行），作为非结构化失败的可读原因。
function lastFailureLine(content: string): string | null {
  const lines = content.split("\n");
  let stackLine: string | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    if (/Exception|Error|Caused by/.test(line)) return line.slice(0, 300);
    if (!stackLine && /^at\s/.test(line)) stackLine = line.slice(0, 300);
  }
  return stackLine;
}
