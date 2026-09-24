import { readReadyModel } from "@/lib/read-ready-model";
import {
  changeFailureAnalysisBatchInputSchema,
  startFailureAnalysisBatchInputSchema,
  startFailureAnalysisBatchResultSchema,
} from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authorizeRequest, requireSameOrigin, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  projectId: z.string().min(1),
  view: z.enum(["started", "available", "archived"]).default("started"),
  projectVersionId: z.string().min(1).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    await authorizeRequest(request, "run.read", input.projectId);
    const services = await getPlatformServices();
    const page = await readReadyModel(
      services.readModels,
      {
        kind: "analysis_batches",
        lifecycleVersion: 2,
        projectId: input.projectId,
        view: input.view,
        limit: input.limit,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      request.signal,
    );
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const input = startFailureAnalysisBatchInputSchema.parse(await readJsonBody(request, 8 * 1024));
    const identity = await authorizeRequest(request, "analysis.manage", input.projectId);
    const services = await getPlatformServices();
    const result = await services.failureAnalysis.startBatch({
      ...input,
      startedBy: identity.user.id,
    });
    if (result.created)
      await services.identityAccess.recordAuthorizedOperation(identity, {
        action: "failure_analysis.batch_started",
        resourceType: "run_batch",
        resourceId: input.batchId,
        projectId: input.projectId,
        requestId: currentRequestId,
        details: {},
      });
    return NextResponse.json(startFailureAnalysisBatchResultSchema.parse(result), {
      status: result.created ? 201 : 200,
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const { action, ...scope } = changeFailureAnalysisBatchInputSchema.parse(
      await readJsonBody(request, 8 * 1024),
    );
    const identity = await authorizeRequest(request, "analysis.assign", scope.projectId);
    const services = await getPlatformServices();
    const changed =
      action === "close"
        ? await services.failureAnalysis.closeBatch(scope)
        : await services.failureAnalysis.archiveBatch({ ...scope, archivedBy: identity.user.id });
    if (changed)
      await services.identityAccess.recordAuthorizedOperation(identity, {
        action:
          action === "close" ? "failure_analysis.batch_closed" : "failure_analysis.batch_archived",
        resourceType: "run_batch",
        resourceId: scope.batchId,
        projectId: scope.projectId,
        requestId: currentRequestId,
        details: {},
      });
    return NextResponse.json({ changed });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
