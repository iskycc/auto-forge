import { redactLogChunks } from "@autoforge/application";
import { uploadLogChunksInputSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";

import { mapApiError, rejectRateLimited } from "./api-error-mapping";
import { refillBatchAfterCompletion } from "./refill-batch-after-completion";
import { getPlatformServices } from "./services";

/**
 * 组合根执行机协议快路径的业务桥接器。传输层（server/runner-fast-path.ts）
 * 使用 NodeNext 构建，不能导入工作区包；鉴权、限流、校验、调度和错误映射在
 * 这里复用与 Route Handler 完全相同的应用服务与规则。
 */
export interface RunnerFastPathRoute {
  kind: "complete" | "logs" | "claims";
  attemptId?: string;
  runnerId?: string;
}

export interface RunnerFastPathContext {
  rawBody: Buffer | null;
  bearerToken: string;
  runnerIdHeader: string | null;
  requestId: string;
}

interface RunnerFastPathBridge {
  dispatch(
    route: RunnerFastPathRoute,
    context: RunnerFastPathContext,
  ): Promise<{ status: number; payload: unknown }>;
}

const RATE_WINDOW_MS = 60_000;
const COMPLETE_RATE_LIMIT = 300;
const LOGS_RATE_LIMIT = 600;

const globalHandles = globalThis as typeof globalThis & {
  __autoforgeRunnerFastPath?: RunnerFastPathBridge;
  __autoforgePublishAttemptLogs?: (
    attemptId: string,
    chunks: Array<{
      stream: "stdout" | "stderr" | "agent";
      sequence: number;
      content: string;
      recordedAt: string;
    }>,
  ) => void;
};

export function registerRunnerFastPathBridge(): void {
  globalHandles.__autoforgeRunnerFastPath = { dispatch };
}

async function dispatch(
  route: RunnerFastPathRoute,
  context: RunnerFastPathContext,
): Promise<{ status: number; payload: unknown }> {
  try {
    const payload = await execute(route, context);
    return { status: 200, payload };
  } catch (error) {
    const mapped = mapApiError(error, context.requestId);
    return { status: mapped.status, payload: mapped.body };
  }
}

async function execute(
  route: RunnerFastPathRoute,
  context: RunnerFastPathContext,
): Promise<unknown> {
  if (!context.rawBody) {
    throw new DomainError("REQUEST_BODY_TOO_LARGE", "请求体超过允许的大小。");
  }
  const services = await getPlatformServices();
  switch (route.kind) {
    case "claims": {
      const runnerId = route.runnerId;
      if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
      rejectRateLimited(
        await services.runnerRequestLimiter.allow(
          `runner:claim:v1:${runnerId}`,
          services.config.runnerClaimRateLimitPerMinute,
          RATE_WINDOW_MS,
        ),
      );
      return services.runnerProtocol.claim(
        runnerId,
        context.bearerToken,
        parseJsonBody(context.rawBody),
      );
    }
    case "logs": {
      const runnerId = requireRunnerHeader(context);
      rejectRateLimited(
        await services.runnerRequestLimiter.allow(
          `runner:logs:v1:${runnerId}`,
          LOGS_RATE_LIMIT,
          RATE_WINDOW_MS,
        ),
      );
      const attemptId = requireAttemptId(route);
      const input = uploadLogChunksInputSchema.parse(parseJsonBody(context.rawBody));
      const result = await services.runnerProtocol.uploadLogs(
        runnerId,
        context.bearerToken,
        attemptId,
        input,
      );
      globalHandles.__autoforgePublishAttemptLogs?.(attemptId, redactLogChunks(input.chunks, []));
      return result;
    }
    case "complete": {
      const runnerId = requireRunnerHeader(context);
      rejectRateLimited(
        await services.runnerRequestLimiter.allow(
          `runner:complete:v1:${runnerId}`,
          COMPLETE_RATE_LIMIT,
          RATE_WINDOW_MS,
        ),
      );
      const attemptId = requireAttemptId(route);
      const result = await services.runnerProtocol.complete(
        runnerId,
        context.bearerToken,
        attemptId,
        parseJsonBody(context.rawBody),
      );
      await refillBatchAfterCompletion(result, (batchId) =>
        result.hasSchedulableRuns === false
          ? Promise.resolve()
          : services.runScheduling.schedule(batchId),
      );
      return result;
    }
  }
}

function requireRunnerHeader(context: RunnerFastPathContext): string {
  if (!context.runnerIdHeader) {
    throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
  }
  return context.runnerIdHeader;
}

function requireAttemptId(route: RunnerFastPathRoute): string {
  if (!route.attemptId) throw new DomainError("RUN_ATTEMPT_NOT_FOUND", "指定的执行尝试不存在。");
  return route.attemptId;
}

function parseJsonBody(rawBody: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch (error) {
    throw new DomainError("INVALID_JSON", "请求体必须是有效的 UTF-8 JSON。", { cause: error });
  }
}
