import type { RunnerHeartbeatInput, RunnerRegistrationInput } from "@autoforge/contracts";
import { DomainError, runnerAuthenticationBlock, type Runner } from "@autoforge/domain";

import type {
  Clock,
  ExecutionControlRepository,
  IdGenerator,
  RunBatchRepository,
  RunBatchSchedulingPort,
  RunnerCredentialPort,
  RunnerRepository,
  RunnerInstallationProfileRepository,
} from "./ports";
import { buildRecoverySchedulingEvents } from "./recovery-scheduling-events";
import { discardableRunnerBatchCacheIds } from "./reconcile-runner-batch-cache";

const HEARTBEAT_INTERVAL_SECONDS = 15;
const OFFLINE_AFTER_SECONDS = 45;
const CREDENTIAL_ROTATION_GRACE_MS = 15 * 60_000;
const DEREGISTER_RECOVERY_LIMIT = 100;

/**
 * Runner Protocol 的严格凭据守卫：身份必须匹配，且未注销、未撤销、未禁用。
 * claim、续租、完成和轮换使用该守卫；心跳使用下方仅放宽 disabled 的守卫。
 */
export function assertRunnerAuthenticated(runner: Runner | null, runnerId: string): Runner {
  const authenticated = assertRunnerIdentityAuthenticated(runner, runnerId);
  if (runnerAuthenticationBlock(authenticated) === "disabled") {
    throw new DomainError("RUNNER_DISABLED", "执行机已被禁用。");
  }
  return authenticated;
}

/**
 * 心跳在 disabled 状态仍允许认证，用于向 Agent 下发 drain 并回收已终态批次缓存；
 * claim、续租、完成和轮换仍使用严格守卫，不能借心跳恢复执行权。
 */
function assertRunnerHeartbeatAuthenticated(runner: Runner | null, runnerId: string): Runner {
  return assertRunnerIdentityAuthenticated(runner, runnerId);
}

function assertRunnerIdentityAuthenticated(runner: Runner | null, runnerId: string): Runner {
  if (!runner || runner.id !== runnerId) {
    throw new DomainError("RUNNER_AUTH_REJECTED", "执行机凭据无效。");
  }
  const block = runnerAuthenticationBlock(runner);
  if (block === "deregistered") {
    throw new DomainError("RUNNER_AUTH_REJECTED", "执行机已注销，凭据已失效。");
  }
  if (block === "credential-revoked") {
    throw new DomainError("RUNNER_AUTH_REJECTED", "执行机凭据已撤销。");
  }
  return runner;
}

export class RunnerControlService {
  constructor(
    private readonly runners: RunnerRepository,
    private readonly credentials: RunnerCredentialPort,
    private readonly executions: ExecutionControlRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly batches: RunBatchRepository,
    private readonly scheduling: RunBatchSchedulingPort,
    private readonly installationProfiles?: RunnerInstallationProfileRepository,
  ) {}

  async register(bootstrapToken: string, input: RunnerRegistrationInput) {
    if (!this.credentials.verifyBootstrapToken(bootstrapToken)) {
      throw new DomainError("RUNNER_BOOTSTRAP_REJECTED", "执行机注册令牌无效。");
    }
    const credential = this.credentials.issue();
    const recordedAt = this.clock.now().toISOString();
    const runner = await this.runners.register({
      id: this.ids.next(),
      bootstrapTokenHash: this.credentials.hash(bootstrapToken),
      credentialHash: this.credentials.hash(credential),
      name: input.name,
      os: input.os,
      architecture: input.architecture,
      agentVersion: input.agentVersion,
      protocolVersion: input.protocolVersion,
      labels: [...new Set(input.labels)],
      capabilities: [...new Set(input.capabilities)],
      maxConcurrency: input.maxConcurrency,
      terminalEnabled: input.terminalEnabled,
      recordedAt,
    });
    if (!runner) {
      throw new DomainError("RUNNER_BOOTSTRAP_REJECTED", "执行机注册令牌已使用。");
    }
    await this.installationProfiles?.bindPending({
      runnerName: runner.name,
      runnerId: runner.id,
      updatedAt: recordedAt,
    });
    return {
      runner,
      result: {
        schemaVersion: 1 as const,
        runnerId: runner.id,
        credential,
        heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      },
    };
  }

  issueBootstrapToken(): string {
    return this.credentials.issueBootstrapToken();
  }

  async heartbeat(runnerId: string, credential: string, input: RunnerHeartbeatInput) {
    const runner = await this.authenticateHeartbeat(runnerId, credential);
    if (input.busySlots > input.maxConcurrency) {
      throw new DomainError("RUNNER_CAPACITY_INVALID", "执行机忙碌槽位不能超过最大并发数。");
    }
    const acceptedAt = this.clock.now().toISOString();
    await this.runners.heartbeat({
      runnerId: runner.id,
      labels: [...new Set(input.labels)],
      capabilities: [...new Set(input.capabilities)],
      maxConcurrency: input.maxConcurrency,
      busySlots: input.busySlots,
      agentVersion: input.agentVersion,
      terminalEnabled: input.terminalEnabled,
      ...(input.resourceSnapshot
        ? { resourceSnapshot: { ...input.resourceSnapshot, observedAt: acceptedAt } }
        : {}),
      recordedAt: acceptedAt,
    });
    const closedBatchIds = await discardableRunnerBatchCacheIds(
      this.batches,
      runnerId,
      input.cachedBatchIds ?? [],
    );
    return {
      schemaVersion: 1 as const,
      acceptedAt,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      draining: runner.state === "disabled" || runner.state === "draining",
      disabled: runner.state === "disabled",
      rotateCredential: Boolean(runner.credentialRotationRequestedAt),
      closedBatchIds,
    };
  }

  async list(limit = 500) {
    return this.runners.list(this.offlineBefore(), limit);
  }

  async get(runnerId: string) {
    const runner = await this.runners.get(runnerId, this.offlineBefore());
    if (!runner) throw new DomainError("RUNNER_NOT_FOUND", "指定的执行机不存在。");
    return runner;
  }

  async setLifecycleState(runnerId: string, state: "active" | "draining" | "disabled") {
    await this.get(runnerId);
    return this.runners.setLifecycleState({
      runnerId,
      state,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  /**
   * Agent 发起的凭据轮换：签发新凭据，旧凭据保留有限宽限期。
   * Agent 保存新凭据失败时可用旧凭据重试轮换，因此轮换必须可安全重复。
   */
  async rotateCredential(runnerId: string, credential: string) {
    const runner = await this.authenticate(runnerId, credential);
    const rotated = this.credentials.issue();
    const now = this.clock.now();
    const previousCredentialValidUntil = new Date(
      now.getTime() + CREDENTIAL_ROTATION_GRACE_MS,
    ).toISOString();
    const updated = await this.runners.rotateCredential({
      runnerId: runner.id,
      credentialHash: this.credentials.hash(rotated),
      previousCredentialValidUntil,
      rotatedAt: now.toISOString(),
    });
    return {
      schemaVersion: 1 as const,
      credential: rotated,
      credentialVersion: updated.credentialVersion,
      previousCredentialValidUntil,
    };
  }

  async requestCredentialRotation(runnerId: string) {
    const runner = await this.get(runnerId);
    if (runner.deregisteredAt || runner.credentialRevokedAt) {
      throw new DomainError("RUNNER_CREDENTIAL_UNAVAILABLE", "执行机身份已失效，无法请求轮换。", {
        details: { runnerId },
      });
    }
    return this.runners.requestCredentialRotation({
      runnerId,
      requestedAt: this.clock.now().toISOString(),
    });
  }

  async revokeCredential(runnerId: string) {
    await this.get(runnerId);
    return this.runners.revokeCredential({
      runnerId,
      revokedAt: this.clock.now().toISOString(),
    });
  }

  /**
   * 注销执行机：身份失效并禁用，活跃租约立即到期以便重新排队。
   * 回收命中的 attempt 同步写调度事件，让总体/单 Runner 日志能看到回收原因。
   */
  async deregisterRunner(runnerId: string) {
    await this.get(runnerId);
    const now = this.clock.now().toISOString();
    const runner = await this.runners.deregister({ runnerId, deregisteredAt: now });
    const recovered = await this.executions.recoverExpired({
      now,
      eventIds: Array.from({ length: DEREGISTER_RECOVERY_LIMIT }, () => this.ids.next()),
      limit: DEREGISTER_RECOVERY_LIMIT,
    });
    const recoveryEvents = await buildRecoverySchedulingEvents({
      recovered,
      executions: this.executions,
      recordedAt: now,
      nextEventId: () => this.ids.next(),
    });
    if (recoveryEvents.length > 0) {
      await this.batches.appendSchedulingEvents(recoveryEvents);
    }
    const recoveredBatchIds = new Set(
      recovered.filter((item) => item.retryScheduled).map((item) => item.batchId),
    );
    for (const batchId of recoveredBatchIds) {
      await this.scheduling.schedule(batchId);
    }
    return runner;
  }

  /**
   * 清除已注销执行机的平台记录（墓碑 purge）：执行历史通过外键保留，
   * 记录从列表隐藏且凭据材料彻底失效。仅允许在注销之后执行；重复清除幂等返回。
   */
  async purgeRunner(runnerId: string) {
    const runner = await this.get(runnerId);
    if (!runner.deregisteredAt) {
      throw new DomainError("RUNNER_NOT_DELETABLE", "执行机尚未注销，请先注销后再删除记录。", {
        details: { runnerId },
      });
    }
    if (runner.purgedAt) {
      return runner;
    }
    return this.runners.purge({ runnerId, purgedAt: this.clock.now().toISOString() });
  }

  private async authenticate(runnerId: string, credential: string) {
    if (!credential) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机凭据。");
    const runner = await this.runners.findByCredentialHash(
      this.credentials.hash(credential),
      this.clock.now().toISOString(),
    );
    return assertRunnerAuthenticated(runner, runnerId);
  }

  private async authenticateHeartbeat(runnerId: string, credential: string) {
    if (!credential) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机凭据。");
    const runner = await this.runners.findByCredentialHash(
      this.credentials.hash(credential),
      this.clock.now().toISOString(),
    );
    return assertRunnerHeartbeatAuthenticated(runner, runnerId);
  }

  private offlineBefore(): string {
    return new Date(this.clock.now().getTime() - OFFLINE_AFTER_SECONDS * 1000).toISOString();
  }
}
