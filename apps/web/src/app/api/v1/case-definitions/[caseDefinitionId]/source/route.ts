import { NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ caseDefinitionId: string }> },
) {
  try {
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.read");
    const definition = await services.caseDefinitions.get(caseDefinitionId, projectIds);
    services.identityAccess.authorize(identity, "case_source.read", definition.projectId);
    return NextResponse.json(
      await services.caseSources.readDefinitionSource(caseDefinitionId, projectIds),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
