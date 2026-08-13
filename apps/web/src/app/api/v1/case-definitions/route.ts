import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest, authorizedProjectScope } from "@/lib/auth";

export const runtime = "nodejs";

const querySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const url = new URL(request.url);
    const input = querySchema.parse({
      query: url.searchParams.get("query") ?? undefined,
      projectId: url.searchParams.get("projectId") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const projectIds = authorizedProjectScope(identity, "case.read", input.projectId);
    const page = await (
      await getPlatformServices()
    ).catalog.listCases({
      ...(projectIds ? { projectIds } : {}),
      limit: input.limit,
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return NextResponse.json(page);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
