import type { RunnerHeartbeatInput, RunnerRegistrationInput } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import type { Clock, IdGenerator, RunnerCredentialPort, RunnerRepository } from "./ports";

const HEARTBEAT_INTERVAL_SECONDS = 15;
const OFFLINE_AFTER_SECONDS = 45;

export class RunnerControlService {
  constructor(
    private readonly runners: RunnerRepository,
    private readonly credentials: RunnerCredentialPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
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
      maxConcurrency: input.maxConcurrency,
      terminalEnabled: input.terminalEnabled,
      recordedAt,
    });
    if (!runner) {
      throw new DomainError("RUNNER_BOOTSTRAP_REJECTED", "执行机注册令牌已使用。");
    }
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

  async heartbeat(runnerId: string, credential: string, input: RunnerHeartbeatInput) {
    const runner = await this.authenticate(runnerId, credential);
    if (input.busySlots > input.maxConcurrency) {
      throw new DomainError("RUNNER_CAPACITY_INVALID", "执行机忙碌槽位不能超过最大并发数。");
    }
    const acceptedAt = this.clock.now().toISOString();
    await this.runners.heartbeat({
      runnerId: runner.id,
      labels: [...new Set(input.labels)],
      maxConcurrency: input.maxConcurrency,
      busySlots: input.busySlots,
      agentVersion: input.agentVersion,
      terminalEnabled: input.terminalEnabled,
      ...(input.resourceSnapshot
        ? { resourceSnapshot: { ...input.resourceSnapshot, observedAt: acceptedAt } }
        : {}),
      recordedAt: acceptedAt,
    });
    return {
      schemaVersion: 1 as const,
      acceptedAt,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      draining: runner.state === "disabled",
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

  private async authenticate(runnerId: string, credential: string) {
    if (!credential) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机凭据。");
    const runner = await this.runners.findByCredentialHash(this.credentials.hash(credential));
    if (!runner || runner.id !== runnerId) {
      throw new DomainError("RUNNER_AUTH_REJECTED", "执行机凭据无效。");
    }
    if (runner.state === "disabled") {
      throw new DomainError("RUNNER_DISABLED", "执行机已被禁用。");
    }
    return runner;
  }

  private offlineBefore(): string {
    return new Date(this.clock.now().getTime() - OFFLINE_AFTER_SECONDS * 1000).toISOString();
  }
}
