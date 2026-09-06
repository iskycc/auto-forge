import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { authenticateRequest } from "@/lib/auth";
import { boundedDetailResponse, detailViewSchema } from "@/lib/bounded-detail-response";

type Context = { params: Promise<{ batchId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    const summary = await services.runBatches.getMetadata(batchId, projectIds);
    return await boundedDetailResponse({
      summary,
      memberCount: summary.totalRuns,
      view: detailViewSchema.parse(new URL(request.url).searchParams.get("view") ?? undefined),
      pageUrl: `/api/v1/run-batches/${encodeURIComponent(batchId)}/cases`,
      load: () => services.runBatches.get(batchId, projectIds),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
