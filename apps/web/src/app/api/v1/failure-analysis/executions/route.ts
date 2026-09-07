import { failureAnalysisExecutionHistorySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  projectId: z.string().min(1).max(128),
  analysisId: z.string().min(1).max(128),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    await authorizeRequest(request, "run.read", input.projectId);
    const services = await getPlatformServices();
    const history = await services.failureAnalysis.listPreviousExecutions(input);
    return NextResponse.json(failureAnalysisExecutionHistorySchema.parse(history), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
