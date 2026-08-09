import { auditListQuerySchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { authenticateRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const input = auditListQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json(
      await (
        await getPlatformServices()
      ).identityAccess.listAudit(identity, {
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.resourceType ? { resourceType: input.resourceType } : {}),
        ...(input.result ? { result: input.result } : {}),
        ...(input.recordedAfter ? { recordedAfter: input.recordedAfter } : {}),
        ...(input.recordedBefore ? { recordedBefore: input.recordedBefore } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit,
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
