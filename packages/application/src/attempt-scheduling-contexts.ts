import type { AttemptSchedulingContext, ExecutionControlRepository } from "./ports";

/**
 * 优先走适配器批量查询；测试 fake 或相邻版本适配器尚未实现时保持兼容，
 * 但仍并行解析，避免把数据库往返串行放大为领取延迟。
 */
export async function resolveAttemptSchedulingContexts(
  executions: ExecutionControlRepository,
  attemptIds: readonly string[],
): Promise<Map<string, AttemptSchedulingContext>> {
  if (attemptIds.length === 0) return new Map();
  if (executions.resolveAttemptSchedulingContexts) {
    const contexts = await executions.resolveAttemptSchedulingContexts(attemptIds);
    return new Map(contexts.map(({ attemptId, ...context }) => [attemptId, context]));
  }
  const contexts = await Promise.all(
    attemptIds.map(async (attemptId) => ({
      attemptId,
      context: await executions.resolveAttemptSchedulingContext(attemptId),
    })),
  );
  return new Map(
    contexts.flatMap(({ attemptId, context }) => (context ? [[attemptId, context]] : [])),
  );
}
