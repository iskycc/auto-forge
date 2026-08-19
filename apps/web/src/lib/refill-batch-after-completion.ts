import type { CompleteAttemptResponse } from "@autoforge/contracts";

/**
 * 完成结果已持久化后立即补充批次槽位。accepted 与 duplicate 都执行：后者覆盖
 * 上次调度失败或 HTTP 响应丢失后的幂等重放。调度错误必须向上传播，让 Agent
 * 使用相同 completionId 重试，不能返回成功后退化成等待下一次心跳。
 */
export async function refillBatchAfterCompletion(
  response: CompleteAttemptResponse,
  schedule: (batchId: string) => Promise<unknown>,
): Promise<void> {
  if (response.disposition === "late" || !response.batchId) return;
  await schedule(response.batchId);
}
