import { failureAnalysisHistoryPageSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type Context = { params: Promise<{ caseDefinitionId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { caseDefinitionId } = await context.params;
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case.read");
    const definition = await services.caseDefinitions.get(caseDefinitionId, projectIds);
    const page = await services.failureAnalysis.listCaseHistory({
      projectId: definition.projectId,
      caseDefinitionId,
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return NextResponse.json(failureAnalysisHistoryPageSchema.parse(page), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
