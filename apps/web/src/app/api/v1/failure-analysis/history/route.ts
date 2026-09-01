import { failureAnalysisHistoryItemSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  projectId: z.string().min(1),
  caseDefinitionIds: z.array(z.string().min(1)).min(1).max(100),
  limitPerCase: z.coerce.number().int().min(1).max(10).default(5),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const searchParams = new URL(request.url).searchParams;
    const input = querySchema.parse({
      projectId: searchParams.get("projectId"),
      caseDefinitionIds: searchParams.getAll("caseDefinitionId"),
      limitPerCase: searchParams.get("limitPerCase") ?? undefined,
    });
    await authorizeRequest(request, "run.read", input.projectId);
    const services = await getPlatformServices();
    const items = await services.failureAnalysis.listRecentCaseHistories(input);
    return NextResponse.json(
      { items: failureAnalysisHistoryItemSchema.array().parse(items) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
