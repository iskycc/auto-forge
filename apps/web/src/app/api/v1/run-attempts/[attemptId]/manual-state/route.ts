import { NextResponse } from "next/server";
import { authenticateRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    const attempt = await services.runBatches.getManualAttemptContext(attemptId);
    services.identityAccess.authorize(identity, "log.read", attempt.projectId);
    return NextResponse.json({ attemptId, status: attempt.status });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
