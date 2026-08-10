import type {
  AcquireAttemptSecretsInput,
  ClaimAssignmentsInput,
  ClaimAssignmentsResponse,
  CompleteAttemptInput,
  DeclareArtifactsInput,
  ReconcileAttemptsInput,
  RenewLeaseInput,
  UploadLogChunksInput,
} from "@autoforge/contracts";
import { assessRunnerCompatibility, DomainError } from "@autoforge/domain";

import type {
  Clock,
  ExecutionControlRepository,
  IdGenerator,
  RunnerCredentialPort,
  JarObjectStorePort,
  RunnerRepository,
  SecretCipherPort,
} from "./ports";
import { executionSecretPurpose } from "./manage-execution-environments";

const LEASE_DURATION_MS = 45_000;
const RECOVERY_SCAN_LIMIT = 100;

export class ExecutionControlService {
  constructor(
    private readonly executions: ExecutionControlRepository,
    private readonly runners: RunnerRepository,
    private readonly credentials: RunnerCredentialPort,
    private readonly cipher: SecretCipherPort,
    private readonly objectStore: JarObjectStorePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
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
    await this.executions.recoverExpired({
      now: now.toISOString(),
      eventIds: Array.from({ length: RECOVERY_SCAN_LIMIT }, () => this.ids.next()),
      limit: RECOVERY_SCAN_LIMIT,
    });
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
    return this.executions.completeAttempt({
      runnerId,
      attemptId,
      completionId: input.completionId,
      leaseTokenHash: this.credentials.hash(input.leaseToken),
      resultDigest: this.credentials.hash(JSON.stringify(input.result)),
      result: input.result,
      eventId: this.ids.next(),
      auditEventId: this.ids.next(),
      acceptedAt: this.clock.now().toISOString(),
    });
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
    const stored = await this.objectStore.putArtifact({
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
    const stored = await this.objectStore.verifyArtifactUpload({
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
    const runner = await this.runners.findByCredentialHash(this.credentials.hash(credential));
    if (!runner || runner.id !== runnerId) {
      throw new DomainError("RUNNER_AUTH_REJECTED", "执行机凭据无效。");
    }
    if (runner.state === "disabled") {
      throw new DomainError("RUNNER_DISABLED", "执行机已被禁用。");
    }
    if (runner.protocolVersion !== 1) {
      throw new DomainError("RUNNER_PROTOCOL_UNSUPPORTED", "Runner Protocol 版本不兼容。");
    }
    return runner;
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
