import type { SchedulingEvent } from "@autoforge/domain";

import { roundRecoverySecretPurpose } from "./round-recovery-credentials";
import type {
  Clock,
  IdGenerator,
  JenkinsRoundRecoveryTransport,
  RoundRecoveryClaim,
  RoundRecoveryRepository,
  RunBatchRepository,
  RunBatchSchedulingPort,
  SecretCipherPort,
} from "./ports";

const RECOVERY_LEASE_MS = 30_000;
const JENKINS_POLL_MS = 5_000;

export class RoundRecoveryService {
  constructor(
    private readonly repository: RoundRecoveryRepository,
    private readonly transport: JenkinsRoundRecoveryTransport,
    private readonly cipher: SecretCipherPort,
    private readonly batches: RunBatchRepository,
    private readonly scheduling: RunBatchSchedulingPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async dispatchDue(workerId: string, limit = 10): Promise<number> {
    const now = this.clock.now();
    const claims = await this.repository.claimDue({
      workerId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + RECOVERY_LEASE_MS).toISOString(),
      limit,
    });
    // 同批 lease 同时开始处理，避免排在后面的外部请求尚未开始时 lease 已过期。
    await Promise.all(claims.map((claim) => this.processClaim(workerId, claim)));
    return claims.length;
  }

  private async processClaim(workerId: string, claim: RoundRecoveryClaim): Promise<void> {
    try {
      if (claim.status === "pending") await this.trigger(workerId, claim);
      else if (claim.status === "polling") await this.poll(workerId, claim);
      else if (claim.status === "waiting") await this.resume(workerId, claim);
      else await this.releaseRound(workerId, claim);
    } catch (error) {
      const updatedAt = this.clock.now().toISOString();
      const errorMessage = safeErrorMessage(error);
      const failed = await this.repository.fail({
        batchId: claim.batchId,
        ruleId: claim.ruleId,
        workerId,
        errorMessage,
        eventId: this.ids.next(),
        updatedAt,
      });
      if (failed) {
        await this.appendEvent(claim, `Jenkins 环境恢复失败：${errorMessage}`, updatedAt, {
          state: "failed",
        });
      }
    }
  }

  private async trigger(workerId: string, claim: RoundRecoveryClaim): Promise<void> {
    const credential = this.decryptCredential(claim);
    const result = await this.transport.rebuildLast({
      jobUrl: claim.jenkinsJobUrl,
      credential,
    });
    const updatedAt = this.clock.now();
    const updated = await this.repository.markPolling({
      batchId: claim.batchId,
      ruleId: claim.ruleId,
      workerId,
      sourceBuildNumber: result.sourceBuildNumber,
      availableAt: new Date(updatedAt.getTime() + JENKINS_POLL_MS).toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    if (updated) {
      await this.appendEvent(
        claim,
        `第 ${claim.afterRound} 轮完成，已触发 Jenkins 重建并暂停下一轮`,
        updatedAt.toISOString(),
        { state: "polling", sourceBuildNumber: result.sourceBuildNumber },
      );
    }
  }

  private async poll(workerId: string, claim: RoundRecoveryClaim): Promise<void> {
    if (claim.sourceBuildNumber === undefined) {
      throw new Error("Jenkins 恢复记录缺少源构建编号。");
    }
    const result = await this.transport.inspectRebuild({
      jobUrl: claim.jenkinsJobUrl,
      credential: this.decryptCredential(claim),
      sourceBuildNumber: claim.sourceBuildNumber,
      ...(claim.rebuildNumber === undefined ? {} : { rebuildNumber: claim.rebuildNumber }),
      ...(claim.rebuildUrl === undefined ? {} : { rebuildUrl: claim.rebuildUrl }),
    });
    const updatedAt = this.clock.now();
    if (result.status === "failed") {
      const errorMessage = `Jenkins 构建 #${result.buildNumber} 结果为 ${result.result}。`;
      const failed = await this.repository.fail({
        batchId: claim.batchId,
        ruleId: claim.ruleId,
        workerId,
        errorMessage,
        rebuildNumber: result.buildNumber,
        rebuildUrl: result.buildUrl,
        ...(result.startedAt ? { startedAt: result.startedAt } : {}),
        ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
        buildResult: result.result,
        eventId: this.ids.next(),
        updatedAt: updatedAt.toISOString(),
      });
      if (failed) {
        await this.appendEvent(
          claim,
          `Jenkins 环境恢复失败：${errorMessage}`,
          updatedAt.toISOString(),
          {
            state: "failed",
            buildNumber: result.buildNumber,
            buildResult: result.result,
          },
        );
      }
      return;
    }
    if (result.status === "succeeded") {
      const resumeAt = new Date(updatedAt.getTime() + claim.waitMinutes * 60_000);
      const updated = await this.repository.markWaiting({
        batchId: claim.batchId,
        ruleId: claim.ruleId,
        workerId,
        rebuildNumber: result.buildNumber,
        rebuildUrl: result.buildUrl,
        ...(result.startedAt ? { startedAt: result.startedAt } : {}),
        ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
        buildResult: result.result,
        availableAt: resumeAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      });
      if (updated) {
        await this.appendEvent(
          claim,
          `Jenkins 构建 #${result.buildNumber} 已成功，${claim.waitMinutes} 分钟后继续第 ${claim.nextRound} 轮`,
          updatedAt.toISOString(),
          { state: "waiting", buildNumber: result.buildNumber, resumeAt: resumeAt.toISOString() },
        );
      }
      return;
    }
    const updated = await this.repository.markPolling({
      batchId: claim.batchId,
      ruleId: claim.ruleId,
      workerId,
      sourceBuildNumber: claim.sourceBuildNumber,
      ...(result.status === "running"
        ? {
            rebuildNumber: result.buildNumber,
            rebuildUrl: result.buildUrl,
            ...(result.startedAt ? { startedAt: result.startedAt } : {}),
          }
        : {}),
      availableAt: new Date(updatedAt.getTime() + JENKINS_POLL_MS).toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    if (updated && result.status === "running" && claim.rebuildNumber === undefined) {
      await this.appendEvent(
        claim,
        `Jenkins 环境恢复构建 #${result.buildNumber} 正在执行`,
        updatedAt.toISOString(),
        { state: "running", buildNumber: result.buildNumber },
      );
    }
  }

  private async resume(workerId: string, claim: RoundRecoveryClaim): Promise<void> {
    const updatedAt = this.clock.now().toISOString();
    const completion = await this.repository.completeWaitingStep({
      batchId: claim.batchId,
      ruleId: claim.ruleId,
      workerId,
      updatedAt,
    });
    if (completion.outcome === "claim_lost") return;
    if (completion.outcome === "step_completed") {
      await this.appendEvent(
        claim,
        `环境恢复步骤等待结束，仍有 ${completion.remainingSteps} 个同轮步骤未就绪`,
        updatedAt,
        {
          state: "step_completed",
          remainingSteps: completion.remainingSteps,
        },
      );
      return;
    }
    await this.releaseRound(workerId, claim);
  }

  private async releaseRound(workerId: string, claim: RoundRecoveryClaim): Promise<void> {
    let completed: boolean;
    try {
      await this.scheduling.schedule(claim.batchId);
      const updatedAt = this.clock.now().toISOString();
      completed = await this.repository.completeRoundRelease({
        batchId: claim.batchId,
        ruleId: claim.ruleId,
        workerId,
        updatedAt,
      });
    } catch (error) {
      const updatedAt = this.clock.now();
      await this.repository.retryRoundRelease({
        batchId: claim.batchId,
        ruleId: claim.ruleId,
        workerId,
        errorMessage: safeErrorMessage(error),
        availableAt: new Date(updatedAt.getTime() + JENKINS_POLL_MS).toISOString(),
        updatedAt: updatedAt.toISOString(),
      });
      return;
    }
    if (!completed) return;
    const recordedAt = this.clock.now().toISOString();
    await this.appendEvent(
      claim,
      `本轮全部环境恢复步骤等待结束，开始调度第 ${claim.nextRound} 轮`,
      recordedAt,
      {
        state: "resumed",
        barrierComplete: true,
        nextRound: claim.nextRound,
      },
    );
  }

  private decryptCredential(claim: RoundRecoveryClaim): string {
    return this.cipher.decrypt(
      claim.apiKeyCiphertext,
      roundRecoverySecretPurpose(claim.suiteId, claim.ruleId),
    );
  }

  private appendEvent(
    claim: RoundRecoveryClaim,
    message: string,
    recordedAt: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event: SchedulingEvent = {
      id: this.ids.next(),
      batchId: claim.batchId,
      eventType: "round_recovery",
      message,
      payload: { afterRound: claim.afterRound, nextRound: claim.nextRound, ...payload },
      recordedAt,
    };
    return this.batches.appendSchedulingEvents([event]);
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知错误";
  return message.slice(0, 1_000);
}
