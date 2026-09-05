import { createRunBatchInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { issuePermanentShareToken } from "@/lib/permanent-share-token";
import { publicLinkBase } from "@/lib/public-link-base";
import { issueRunProgressToken, RUN_PROGRESS_TOKEN_TTL_SECONDS } from "@/lib/run-progress-token";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createRunBatchInputSchema.parse(await readJsonBody(request, 16 * 1024));
    const services = await getPlatformServices();
    const projectScope = services.identityAccess.projectScope(identity, "run.create");
    // 授权只需任务的归属项目；完整任务快照由 create 内部读取一次，避免重复加载全量用例成员。
    const suite = await services.caseSuites.getSummary(input.suiteId, projectScope);
    services.identityAccess.authorize(identity, "run.create", suite.projectId);
    const batch = await services.runBatches.create(input);
    const progressToken = issueRunProgressToken(
      services.config.masterKey,
      batch.id,
      services.clock.now(),
    );
    const resultToken = issuePermanentShareToken(services.config.masterKey, "run_batch", batch.id);
    const baseUrl = publicLinkBase(services.configurationStore.read().web.publicBaseUrl, request);
    const progressUrl = new URL(`/progress/${encodeURIComponent(batch.id)}`, baseUrl);
    progressUrl.searchParams.set("access_token", progressToken);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "jenkins.run_batch.create",
      resourceType: "run_batch",
      resourceId: batch.id,
      projectId: batch.projectId,
      requestId: currentRequestId,
      details: { suiteId: suite.id, totalRuns: batch.totalRuns },
    });
    return NextResponse.json(
      {
        batchId: batch.id,
        status: batch.status,
        progressUrl: progressUrl.toString(),
        resultUrl: new URL(`/share/run/${encodeURIComponent(resultToken)}`, baseUrl).toString(),
        progressApiUrl: new URL(
          `/api/v1/run-batches/${encodeURIComponent(batch.id)}/progress?access_token=${encodeURIComponent(progressToken)}`,
          baseUrl,
        ).toString(),
        pollIntervalSeconds: 30,
        completionTimeoutSeconds: RUN_PROGRESS_TOKEN_TTL_SECONDS,
      },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
