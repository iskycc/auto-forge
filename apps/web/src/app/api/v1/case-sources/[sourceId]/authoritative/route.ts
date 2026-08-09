import { setAuthoritativeSourceInputSchema } from "@autoforge/contracts";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ sourceId: string }> };

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "case_source.manage");
    setAuthoritativeSourceInputSchema.parse(await request.json());
    const { sourceId } = await context.params;
    const services = await getPlatformServices();
    const source = await services.caseSources.setAuthoritative(sourceId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.set_authoritative",
      resourceType: "case_source",
      resourceId: sourceId,
      requestId: currentRequestId,
    });
    return NextResponse.json(source);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
