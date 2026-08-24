import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { issuePermanentShareToken } from "@/lib/permanent-share-token";
import { publicLinkBase } from "@/lib/public-link-base";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string }> };

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.read");
    const definition = await services.caseDefinitions.get(caseDefinitionId, projectIds);
    services.identityAccess.authorize(identity, "case.read", definition.projectId);
    const token = issuePermanentShareToken(
      services.config.masterKey,
      "case_definition",
      definition.id,
    );
    const baseUrl = publicLinkBase(services.config.web.publicBaseUrl, request);
    const shareUrl = new URL(`/share/case/${encodeURIComponent(token)}`, baseUrl).toString();
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_definition.share",
      resourceType: "case_definition",
      resourceId: definition.id,
      projectId: definition.projectId,
      requestId: currentRequestId,
      details: { permanent: true },
    });
    return NextResponse.json({ caseDefinitionId: definition.id, shareUrl, permanent: true });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
