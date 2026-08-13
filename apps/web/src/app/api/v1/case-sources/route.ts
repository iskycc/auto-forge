import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest, authorizedProjectScope } from "@/lib/auth";

const querySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const { limit, projectId } = querySchema.parse({
      projectId: url.searchParams.get("projectId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const projectIds = authorizedProjectScope(identity, "case_source.read", projectId);
    return NextResponse.json({
      items: await (await getPlatformServices()).catalog.listSources(limit, projectIds),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
