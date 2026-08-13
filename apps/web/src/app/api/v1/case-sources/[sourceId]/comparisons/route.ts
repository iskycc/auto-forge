import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ sourceId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { sourceId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_source.manage");
    const comparison = await services.caseSources.compareSources(
      sourceId,
      identity.user.id,
      projectIds,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.compare",
      resourceType: "case_source",
      resourceId: sourceId,
      projectId: comparison.projectId,
      requestId: currentRequestId,
    });
    return NextResponse.json(comparison, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
