import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const identity = await authenticateRequest(request);
    const { batchId } = z
      .object({ batchId: z.string().min(1).max(128) })
      .parse(await context.params);
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    const batch = await services.runBatches.getMetadata(batchId, projectIds);
    services.identityAccess.authorize(identity, "runner.read", batch.projectId);
    const result = await services.concurrencyDiagnostics.read(batchId, projectIds);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
