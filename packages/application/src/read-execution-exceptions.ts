import {
  executionExceptionCursorSchema,
  executionExceptionPageSchema,
  type ExecutionExceptionPage,
} from "@autoforge/contracts";
import { aggregateBatchStatus, DomainError } from "@autoforge/domain";
import type { RunBatchMetadata, RunBatchRepository } from "./ports";

type ExceptionRepository = Pick<RunBatchRepository, "getMetadata" | "readExceptionRecords">;
type ExceptionPageInput = { cursor?: string; limit?: number; scope?: "all" | "terminal" };
type ExceptionAudit = Pick<
  ExecutionExceptionPage,
  "status" | "expectedStatus" | "consistent" | "abnormalRuns"
>;

/** Read persisted evidence independently of background charts and their refresh state. */
export async function readExecutionExceptions(
  batches: ExceptionRepository,
  input: {
    batchId: string;
    projectIds?: readonly string[];
    cursor?: string;
    limit?: number;
    scope?: "all" | "terminal";
  },
): Promise<ExecutionExceptionPage> {
  const batch = await accessibleBatchMetadata(batches, input);
  return readExceptionPage(batches, batch, input);
}

export async function prepareExecutionExceptionExport(
  batches: ExceptionRepository,
  input: { batchId: string; projectIds?: readonly string[] },
): Promise<{ firstPage: ExecutionExceptionPage; pages: AsyncIterable<ExecutionExceptionPage> }> {
  const batch = await accessibleBatchMetadata(batches, input);
  const firstPage = await readExceptionPage(batches, batch, { scope: "all", limit: 100 });
  async function* pages(): AsyncGenerator<ExecutionExceptionPage> {
    let page = firstPage;
    while (true) {
      yield page;
      if (!page.nextCursor) return;
      page = await readExceptionPage(
        batches,
        batch,
        { scope: "all", limit: 100, cursor: page.nextCursor },
        firstPage,
      );
    }
  }
  return { firstPage, pages: pages() };
}

async function accessibleBatchMetadata(
  batches: ExceptionRepository,
  input: { batchId: string; projectIds?: readonly string[] },
): Promise<RunBatchMetadata> {
  const batch = await batches.getMetadata(input.batchId, input.projectIds);
  if (!batch || batch.kind === "case_log_rerun")
    throw new DomainError("RUN_BATCH_NOT_FOUND", "执行批次不存在或当前身份无权访问。");
  return batch;
}

async function readExceptionPage(
  batches: ExceptionRepository,
  batch: RunBatchMetadata,
  input: ExceptionPageInput,
  initialAudit?: ExceptionAudit,
): Promise<ExecutionExceptionPage> {
  const requestedLimit = input.limit ?? 50;
  const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
  const after = input.cursor ? parseCursor(input.cursor) : undefined;
  const records = await batches.readExceptionRecords({
    batchId: batch.id,
    limit: limit + 1,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(after ? { after } : {}),
    ...(initialAudit ? { includeCompletions: false } : {}),
  });
  const audit = initialAudit ?? auditBatchStatus(batch, records.completions);
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
    status: audit.status,
    expectedStatus: audit.expectedStatus,
    consistent: audit.consistent,
    abnormalRuns: audit.abnormalRuns,
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

function auditBatchStatus(
  batch: RunBatchMetadata,
  completions: Awaited<ReturnType<RunBatchRepository["readExceptionRecords"]>>["completions"],
): ExceptionAudit {
  const expectedStatus = aggregateBatchStatus(
    completions.map(({ status, abnormal }) => ({
      status,
      terminalReasonCode: abnormal ? "EXECUTION_EXCEPTION" : "TESTNG_ASSERTIONS_FAILED",
    })),
    { terminationRequested: !!batch.terminationRequestedAt },
  );
  return {
    status: batch.status,
    expectedStatus,
    consistent: batch.status === expectedStatus,
    abnormalRuns: completions.reduce((count, row) => count + (row.abnormal ? row.count : 0), 0),
  };
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
