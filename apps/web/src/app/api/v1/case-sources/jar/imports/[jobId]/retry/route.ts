import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_source.manage");
    const { jobId } = await context.params;
    const job = await services.importTestNgJar.retry(jobId, projectIds);
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
