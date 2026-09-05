import { readReadyModel } from "@/lib/read-ready-model";
import { createRunBatchInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  projectId: z.string().min(1).max(128).optional(),
  projectVersionId: z.string().min(1).max(128).optional(),
  suiteId: z.string().min(1).max(128).optional(),
  caseDefinitionId: z.string().min(1).max(128).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
  runnerId: z.string().min(1).max(128).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const query = querySchema.parse(Object.fromEntries(url.searchParams));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    const filter = {
      limit: query.limit,
      ...(projectIds ? { projectIds } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.projectVersionId ? { projectVersionId: query.projectVersionId } : {}),
      ...(query.suiteId ? { suiteId: query.suiteId } : {}),
      ...(query.caseDefinitionId ? { caseDefinitionId: query.caseDefinitionId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.runnerId ? { runnerId: query.runnerId } : {}),
      ...(query.createdAfter ? { createdAfter: query.createdAfter } : {}),
      ...(query.createdBefore ? { createdBefore: query.createdBefore } : {}),
    };
    let result = await services.executionBatchPage(filter);
    if (result.query && result.items.some((batch) => batch.statisticsPending)) {
      await readReadyModel(services.readModels, result.query, request.signal);
      result = await services.executionBatchPage(filter);
    }
    return NextResponse.json(
      { items: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createRunBatchInputSchema.parse(await readJsonBody(request, 128 * 1024));
    const services = await getPlatformServices();
    const projectScope = services.identityAccess.projectScope(identity, "run.create");
    // 授权只需任务的归属项目；完整任务快照由 create 内部读取一次，避免重复加载全量用例成员。
    const suite = await services.caseSuites.getSummary(input.suiteId, projectScope);
    services.identityAccess.authorize(identity, "run.create", suite.projectId);
    const batch = await services.runBatches.create(input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "run_batch.create",
      resourceType: "run_batch",
      resourceId: batch.id,
      projectId: batch.projectId,
      requestId: currentRequestId,
      details: {
        totalRuns: batch.totalRuns,
        retryLimit: batch.retryLimit,
        delaySeconds: input.delaySeconds,
        scheduledFor: batch.scheduledFor,
      },
    });
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
