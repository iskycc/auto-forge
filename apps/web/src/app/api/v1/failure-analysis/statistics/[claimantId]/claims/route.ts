import { failureAnalysisClaimPageSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ claimantId: string }> };

const querySchema = z.object({
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  projectVersionId: z.string().min(1).optional(),
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    await authorizeRequest(request, "audit.read", input.projectId);
    const services = await getPlatformServices();
    const page = await services.failureAnalysis.listAnalystClaims({
      projectId: input.projectId,
      batchId: input.batchId,
      limit: input.limit,
      claimantId: z
        .string()
        .min(1)
        .max(128)
        .parse((await context.params).claimantId),
      ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return NextResponse.json(failureAnalysisClaimPageSchema.parse(page), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
