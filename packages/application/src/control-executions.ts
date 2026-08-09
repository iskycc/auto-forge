import type {
  ClaimAssignmentsInput,
  ClaimAssignmentsResponse,
  CompleteAttemptInput,
  ReconcileAttemptsInput,
  RenewLeaseInput,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import type {
  Clock,
  ExecutionControlRepository,
  IdGenerator,
  RunnerCredentialPort,
  RunnerRepository,
  SecretCipherPort,
} from "./ports";

const LEASE_DURATION_MS = 45_000;
const RECOVERY_SCAN_LIMIT = 100;

export class ExecutionControlService {
  constructor(
    private readonly executions: ExecutionControlRepository,
    private readonly runners: RunnerRepository,
    private readonly credentials: RunnerCredentialPort,
    private readonly cipher: SecretCipherPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async claim(
    runnerId: string,
    credential: string,
    input: ClaimAssignmentsInput,
  ): Promise<ClaimAssignmentsResponse> {
    const runner = await this.authenticateRunner(runnerId, credential);
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

  async cancelBatch(actorId: string, batchId: string, reason: string): Promise<number> {
    return this.executions.cancelBatch({
      batchId,
      actorId,
      reason,
      eventIds: Array.from({ length: 10_000 }, () => this.ids.next()),
      requestedAt: this.clock.now().toISOString(),
    });
  }

  async cancelRun(actorId: string, runId: string, reason: string): Promise<void> {
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
