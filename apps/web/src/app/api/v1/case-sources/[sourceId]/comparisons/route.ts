import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ sourceId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_source.manage");
    const { sourceId } = await context.params;
    const services = await getPlatformServices();
    const comparison = await services.caseSources.compareSources(sourceId, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.compare",
      resourceType: "case_source",
      resourceId: sourceId,
      requestId: currentRequestId,
    });
    return NextResponse.json(comparison, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
