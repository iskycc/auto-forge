import { executionCaseKeysSchema } from "@autoforge/contracts";
import { readReadyModel } from "@/lib/read-ready-model";
import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { readPermanentShareToken } from "@/lib/permanent-share-token";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

const querySchema = z.object({
  cached: z.enum(["1"]).optional(),
  scope: z.union([z.literal("all"), z.literal("summary"), z.coerce.number().int().positive()]),
  status: z
    .enum(["assigned", "running", "succeeded", "failed", "timed_out", "cancelled", "pending"])
    .optional(),
  query: z.string().max(240).optional(),
  sort: z.enum(["none", "name", "status", "runner", "duration"]).default("none"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  access_token: z.string().min(1).optional(),
});

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { batchId } = await context.params;
    const url = new URL(request.url);
    const input = querySchema.parse(Object.fromEntries(url.searchParams));
    const services = await getPlatformServices();
    let projectIds: readonly string[] | undefined;
    if (input.access_token) {
      const sharedBatchId = readPermanentShareToken(
        services.config.masterKey,
        input.access_token,
        "run_batch",
      );
      if (sharedBatchId !== batchId) {
        throw new DomainError("RUN_BATCH_SHARE_TOKEN_INVALID", "执行详情永久分享链接无效。");
      }
    } else {
      const identity = await authenticateRequest(request);
      projectIds = services.identityAccess.projectScope(identity, "run.read");
    }
    if (input.cached) {
      const batch = await services.runBatches.getMetadata(batchId, projectIds);
      const snapshot = executionCaseKeysSchema.parse(
        await readReadyModel(
          services.readModels,
          {
            kind: "execution_case_page",
            projectId: batch.projectId,
            batchId,
            ...(["succeeded", "failed", "cancelled"].includes(batch.status)
              ? { terminalVersion: batch.version }
              : {}),
            filter: {
              scope: input.scope,
              sort: input.sort,
              direction: input.direction,
              offset: (input.page - 1) * input.pageSize,
              limit: input.pageSize,
              ...(input.status ? { status: input.status } : {}),
              ...(input.query ? { query: input.query } : {}),
            },
          },
          request.signal,
        ),
      );
      const items = await services.executionCaseEntries(
        batchId,
        snapshot.keys.map((key) => ({
          runId: key.runId,
          round: key.round,
          ...(key.attemptId ? { attemptId: key.attemptId } : {}),
        })),
      );
      return NextResponse.json(
        { items, total: snapshot.total },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const result = await services.runBatches.listCasePage({
      batchId,
      ...(projectIds ? { projectIds } : {}),
      scope: input.scope,
      ...(input.status ? { status: input.status } : {}),
      ...(input.query ? { query: input.query } : {}),
      sort: input.sort,
      direction: input.direction,
      page: input.page,
      pageSize: input.pageSize,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
