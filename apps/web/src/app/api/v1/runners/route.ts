import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeRequest } from "@/lib/auth";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "runner.read");
    const url = new URL(request.url);
    const { limit } = querySchema.parse({ limit: url.searchParams.get("limit") ?? undefined });
    return NextResponse.json({
      items: await (await getPlatformServices()).runnerControl.list(limit),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
