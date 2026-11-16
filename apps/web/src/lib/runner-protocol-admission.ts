import {
  runnerProtocolRateBudget,
  type RunnerProtocolAdmissionPort,
  type RunnerProtocolOperation,
} from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import type { RequestLimiter } from "./request-limiter";

/** Resource quotas prevent one attempt from consuming its peer slots' budget. */
export async function admitRunnerProtocolResource(
  limiter: RequestLimiter,
  operation: RunnerProtocolOperation,
  runnerId: string,
  resourceId: string,
): Promise<void> {
  const budget = runnerProtocolRateBudget(operation);
  const allowed = await limiter.allow(
    `runner:${operation}:resource:v2:${runnerId}:${resourceId}`,
    budget.resource,
    budget.windowMs,
  );
  if (!allowed)
    throw new DomainError(
      "RATE_LIMITED",
      `执行机 ${operation} 请求超过单次执行／租约每分钟 ${budget.resource} 次的额度；其他用例使用独立额度。`,
    );
}

/** Capacity is supplied only after Runner authentication; request headers cannot raise it. */
export function createRunnerProtocolAdmission(
  limiter: RequestLimiter,
  logBudget?: { requests: number; windowMs: number },
): RunnerProtocolAdmissionPort {
  return {
    async assertAllowed({ operation, runnerId, maximumConcurrency }) {
      if (operation === "logs" && logBudget) {
        const allowed = await limiter.allow(
          "runner:logs:platform:v3",
          logBudget.requests,
          logBudget.windowMs,
        );
        if (!allowed)
          throw new DomainError(
            "RATE_LIMITED",
            `日志上传超过平台每秒 ${logBudget.requests} 次的总额度，请稍后重传。`,
          );
        return;
      }
      const budget = runnerProtocolRateBudget(operation, maximumConcurrency);
      const allowed = await limiter.allow(
        `runner:${operation}:node:v2:${runnerId}`,
        budget.runner,
        budget.windowMs,
      );
      if (!allowed)
        throw new DomainError(
          "RATE_LIMITED",
          `执行机 ${operation} 请求超过节点每分钟 ${budget.runner} 次的总额度（已认证并发槽位 ${maximumConcurrency}）；请检查上传频率与重试。`,
        );
    },
  };
}
