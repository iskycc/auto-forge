import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-response";
import { requestId } from "@/lib/auth";
import { handlePlatformNodeLogs } from "@/lib/platform-node-endpoint";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    return NextResponse.json(await handlePlatformNodeLogs(request));
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
