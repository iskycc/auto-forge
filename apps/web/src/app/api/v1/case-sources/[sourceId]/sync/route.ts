import { confirmCaseSourceSyncInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";

type Context = { params: Promise<{ sourceId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = confirmCaseSourceSyncInputSchema.parse(await readJsonBody(request, 16_384));
    const { sourceId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_source.manage");
    const source = await services.caseSources.confirmSync(
      sourceId,
      input,
      projectIds,
      identity.user.id,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.sync",
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
