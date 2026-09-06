import {
  deleteCaseSourceInputSchema,
  updateCaseSourceLifecycleInputSchema,
} from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { boundedDetailResponse, detailViewSchema } from "@/lib/bounded-detail-response";

type Context = { params: Promise<{ sourceId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_source.read");
    const { sourceId } = await context.params;
    const summary = await services.caseSources.getSummary(sourceId, projectIds);
    return await boundedDetailResponse({
      summary,
      memberCount: summary.classCount,
      view: detailViewSchema.parse(new URL(request.url).searchParams.get("view") ?? undefined),
      pageUrl: `/api/v1/case-sources/${encodeURIComponent(sourceId)}/classes`,
      load: () => services.caseSources.get(sourceId, projectIds),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = updateCaseSourceLifecycleInputSchema.parse(await readJsonBody(request, 16_384));
    const { sourceId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_source.manage");
    const source = await services.caseSources.updateLifecycle(sourceId, input, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: input.archived ? "case_source.archive" : "case_source.restore",
      resourceType: "case_source",
      resourceId: sourceId,
      projectId: source.projectId,
      requestId: currentRequestId,
    });
    return NextResponse.json(source);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = deleteCaseSourceInputSchema.parse(await readJsonBody(request, 16_384));
    const { sourceId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_source.manage");
    const source = await services.caseSources.deleteSource(sourceId, input, projectIds);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.delete",
      resourceType: "case_source",
      resourceId: sourceId,
      projectId: source.projectId,
      requestId: currentRequestId,
    });
    return NextResponse.json(source);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
