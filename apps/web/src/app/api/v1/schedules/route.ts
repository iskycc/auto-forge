import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    return NextResponse.json({
      items: await (await getPlatformServices()).platformOperations.listSchedules(identity),
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
