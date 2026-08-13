import { NextResponse } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.read");
    return NextResponse.json({
      items: await services.caseDefinitions.listVersions(caseDefinitionId, projectIds),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
