import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { executionReadProjectScope } from "@/lib/execution-public-access";
import {
  executionShareAccess,
  executionShareQuerySchema,
  hasExecutionShareAccess,
} from "@/lib/execution-share-query";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const { batchId } = z
      .object({ batchId: z.string().min(1).max(128) })
      .parse(await context.params);
    const services = await getPlatformServices();
    const access = executionShareAccess(
      executionShareQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams)),
    );
    let projectIds: readonly string[] | undefined;
    if (hasExecutionShareAccess(access)) {
      await executionReadProjectScope(request, batchId, access, services);
    } else {
      const identity = await authenticateRequest(request);
      projectIds = services.identityAccess.projectScope(identity, "run.read");
      const batch = await services.runBatches.getMetadata(batchId, projectIds);
      services.identityAccess.authorize(identity, "runner.read", batch.projectId);
    }
    const result = await services.concurrencyDiagnostics.read(batchId, projectIds);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
