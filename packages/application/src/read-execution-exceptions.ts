import {
  executionExceptionCursorSchema,
  executionExceptionPageSchema,
  type ExecutionExceptionPage,
} from "@autoforge/contracts";
import { aggregateBatchStatus, DomainError } from "@autoforge/domain";
import type { RunBatchRepository } from "./ports";

/** Read persisted evidence independently of background charts and their refresh state. */
export async function readExecutionExceptions(
  batches: Pick<RunBatchRepository, "getMetadata" | "readExceptionRecords">,
  input: {
    batchId: string;
    projectIds?: readonly string[];
    cursor?: string;
    limit?: number;
    scope?: "all" | "terminal";
  },
): Promise<ExecutionExceptionPage> {
  const batch = await batches.getMetadata(input.batchId, input.projectIds);
  if (!batch || batch.kind === "case_log_rerun")
    throw new DomainError("RUN_BATCH_NOT_FOUND", "执行批次不存在或当前身份无权访问。");
  const requestedLimit = input.limit ?? 50;
  const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
  const after = input.cursor ? parseCursor(input.cursor) : undefined;
  const records = await batches.readExceptionRecords({
    batchId: batch.id,
    limit: limit + 1,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(after ? { after } : {}),
  });
  const expectedStatus = aggregateBatchStatus(
    records.completions.map(({ status, abnormal }) => ({
      status,
      terminalReasonCode: abnormal ? "EXECUTION_EXCEPTION" : "TESTNG_ASSERTIONS_FAILED",
    })),
    { terminationRequested: !!batch.terminationRequestedAt },
  );
  const items = records.items.slice(0, limit).map((item) =>
    item.kind === "run" && item.resultCode === "QUEUE_TIMEOUT"
      ? {
          ...item,
          summary: `排队等待超过本批次的 ${batch.queueTimeoutMs / 1000} 秒时限，用例尚未生成执行尝试，因此没有本次执行日志。`,
        }
      : item,
  );
  const last = items.at(-1);
  return executionExceptionPageSchema.parse({
    batchId: batch.id,
    status: batch.status,
    expectedStatus,
    consistent: batch.status === expectedStatus,
    abnormalRuns: records.completions.reduce(
      (count, row) => count + (row.abnormal ? row.count : 0),
      0,
    ),
    items,
    ...(records.items.length > limit && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ occurredAt: last.occurredAt, id: last.id }),
          ).toString("base64url"),
        }
      : {}),
  });
}

function parseCursor(cursor: string) {
  try {
    return executionExceptionCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch (cause) {
    throw new DomainError("INVALID_CURSOR", "异常原因分页游标无效，请重新打开。", { cause });
  }
}
