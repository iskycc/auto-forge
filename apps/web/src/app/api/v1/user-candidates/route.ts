import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

const querySchema = z.object({
  purpose: z.enum(["project-member", "project-owner", "system-role", "password"]),
  projectId: z.string().min(1).max(128).optional(),
  query: z.string().trim().max(120).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export async function GET(request: Request): Promise<NextResponse> {
  const id = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const input = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.listUserCandidates(identity, {
        purpose: input.purpose,
        limit: input.limit,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, id);
  }
}
