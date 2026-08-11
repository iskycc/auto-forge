import { DomainError } from "@autoforge/domain";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "case_source.manage");
    const { jobId } = await context.params;
    const job = await services.importTestNgJar.getJob(jobId, projectIds);
    if (!job) throw new DomainError("JAR_IMPORT_JOB_NOT_FOUND", "指定的 JAR 导入任务不存在。");
    return NextResponse.json(job, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
