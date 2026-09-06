import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { loadCaseDetail } from "@/lib/load-case-detail";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ caseDefinitionId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.read");
    const detail = await loadCaseDetail(services, identity, caseDefinitionId, projectIds);
    return NextResponse.json(
      { ...detail, sourceView: null },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
