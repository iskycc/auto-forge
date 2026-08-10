import { NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ environmentId: string }> };
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { environmentId } = await context.params;
    const { limit } = querySchema.parse({
      limit: new URL(request.url).searchParams.get("limit") ?? undefined,
    });
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "environment.read");
    return NextResponse.json(
      await services.executionEnvironments.listReferences(environmentId, projectIds, limit),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
