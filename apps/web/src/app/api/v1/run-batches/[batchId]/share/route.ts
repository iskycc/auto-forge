import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { publicLinkBase } from "@/lib/public-link-base";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ batchId: string }> };

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    const batch = await services.runBatches.getMetadata(batchId, projectIds);
    services.identityAccess.authorize(identity, "run.read", batch.projectId);
    const publicPath = await services.publicExecutionAccess.publishBatch(
      batch.id,
      identity.user.id,
      projectIds,
    );
    const baseUrl = publicLinkBase(services.configurationStore.read().web.publicBaseUrl, request);
    const shareUrl = new URL(publicPath, baseUrl).toString();
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "run_batch.share",
      resourceType: "run_batch",
      resourceId: batch.id,
      projectId: batch.projectId,
      requestId: currentRequestId,
      details: { permanent: true, status: batch.status },
    });
    return NextResponse.json({ batchId: batch.id, shareUrl, permanent: true });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
