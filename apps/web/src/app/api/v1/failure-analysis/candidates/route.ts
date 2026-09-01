import { failureAnalysisSortSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  projectId: z.string().min(1),
  projectVersionId: z.string().min(1),
  batchId: z.string().min(1),
  query: z.string().max(240).optional(),
  sort: failureAnalysisSortSchema.default("class_path"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    await authorizeRequest(request, "run.read", input.projectId);
    const services = await getPlatformServices();
    const page = await services.failureAnalysis.listCandidates({
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      batchId: input.batchId,
      sort: input.sort,
      direction: input.direction,
      limit: input.limit,
      ...(input.query ? { query: input.query } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
