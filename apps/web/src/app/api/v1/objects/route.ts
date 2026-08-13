import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";

export const runtime = "nodejs";

const querySchema = z.object({
  cursor: z.string().min(1).optional(),
  prefix: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_source.read");
    const url = new URL(request.url);
    const input = querySchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      prefix: url.searchParams.get("prefix") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return NextResponse.json(
      await services.caseSources.listObjects(
        {
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          ...(input.prefix ? { prefix: input.prefix } : {}),
        },
        projectIds,
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
