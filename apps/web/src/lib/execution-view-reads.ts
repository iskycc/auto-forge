import { z } from "zod";
import { DomainError } from "@autoforge/domain";
import type { RunBatchRepository } from "@autoforge/application";

export const EXECUTION_VIEW_READ_METHODS = [
  "get",
  "getSummary",
  "getAttemptLogSnapshot",
  "listAttemptsForExecutionRun",
  "listCaseLogRerunBatches",
  "listMetadataPage",
  "listCasePage",
  "readCasePageEntries",
  "readExceptionRecords",
  "readExportPage",
] as const;

const identifier = z.string().min(1).max(160);
const projectScope = z.array(identifier).max(10_000).optional();
const batchArgs = z.tuple([identifier, projectScope]);
const readSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("readExportPage"),
      args: z.tuple([
        z
          .object({
            batchId: identifier,
            scope: z.enum(["round", "final", "all"]),
            round: z.number().int().positive().optional(),
            limit: z.number().int().min(1).max(200),
            after: z
              .object({
                className: z.string().max(4096),
                displayName: z.string().max(4096),
                runId: identifier,
                round: z.number().int().positive(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ method: z.literal("get"), args: batchArgs }).strict(),
  z.object({ method: z.literal("getSummary"), args: batchArgs }).strict(),
  z
    .object({ method: z.literal("getAttemptLogSnapshot"), args: z.tuple([identifier, identifier]) })
    .strict(),
  z
    .object({ method: z.literal("listAttemptsForExecutionRun"), args: z.tuple([identifier]) })
    .strict(),
  z
    .object({
      method: z.literal("listCaseLogRerunBatches"),
      args: z.tuple([identifier, identifier, z.number().int().min(1).max(500)]),
    })
    .strict(),
  z
    .object({
      method: z.literal("listMetadataPage"),
      args: z.tuple([
        z
          .object({
            limit: z.number().int().min(1).max(200),
            projectIds: projectScope,
            projectId: identifier.optional(),
            projectVersionId: identifier.optional(),
            suiteId: identifier.optional(),
            caseDefinitionId: identifier.optional(),
            runnerId: identifier.optional(),
            status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
            createdAfter: z.iso.datetime().optional(),
            createdBefore: z.iso.datetime().optional(),
            cursor: z.string().max(512).optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      method: z.literal("listCasePage"),
      args: z.tuple([
        z
          .object({
            batchId: identifier,
            projectIds: projectScope,
            scope: z.union([z.number().int().positive(), z.enum(["all", "summary", "attempts"])]),
            runnerId: identifier.optional(),
            executionRound: z.number().int().positive().optional(),
            status: z
              .enum([
                "assigned",
                "running",
                "succeeded",
                "failed",
                "timed_out",
                "cancelled",
                "pending",
              ])
              .optional(),
            query: z.string().max(240).optional(),
            sort: z.enum(["none", "name", "status", "runner", "duration"]),
            direction: z.enum(["asc", "desc"]),
            offset: z.number().int().nonnegative(),
            limit: z.number().int().min(1).max(500),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      method: z.literal("readCasePageEntries"),
      args: z.tuple([
        identifier,
        z
          .array(
            z
              .object({
                runId: identifier,
                attemptId: identifier.optional(),
                round: z.number().int().positive(),
              })
              .strict(),
          )
          .max(500),
      ]),
    })
    .strict(),
  z
    .object({
      method: z.literal("readExceptionRecords"),
      args: z.tuple([
        z
          .object({
            batchId: identifier,
            scope: z.enum(["all", "terminal"]).optional(),
            after: z.object({ occurredAt: z.iso.datetime(), id: identifier }).strict().optional(),
            limit: z.number().int().min(1).max(101),
            includeCompletions: z.boolean().optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);

/** Only explicitly selected, read-only execution views may run in the disposable reader. */
export async function readExecutionView(
  batches: RunBatchRepository,
  value: unknown,
): Promise<unknown> {
  const request = readSchema.parse(value);
  // Legacy full details are only a compatibility path for small batches.
  if (request.method === "get") {
    const [batchId, projects] = request.args;
    const metadata = await batches.getMetadata(batchId, projects);
    if (!metadata) return null;
    if (metadata.totalRuns > 500)
      throw new DomainError("DETAIL_RESPONSE_TOO_LARGE", "请使用摘要及分页接口读取大批次。");
    return batches.get(batchId, projects);
  }
  // Parsing above bounds every operation's arguments; repository methods retain their original binding.
  const method = batches[request.method] as (...args: unknown[]) => Promise<unknown>;
  return method.apply(batches, request.args);
}
