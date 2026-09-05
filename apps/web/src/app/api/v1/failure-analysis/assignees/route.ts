import { failureAnalysisAssigneePageSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  projectId: z.string().min(1),
  query: z.string().max(240).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const identity = await authorizeRequest(request, "analysis.assign", input.projectId);
    const services = await getPlatformServices();
    const result = await services.identityAccess.listAnalysisAssignees(identity, {
      projectId: input.projectId,
      limit: input.limit,
      ...(input.query ? { query: input.query } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return NextResponse.json(failureAnalysisAssigneePageSchema.parse(result), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
