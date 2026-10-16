import { NextResponse } from "next/server";
import { z } from "zod";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ projectId: string; versionId: string; batchId: string }> };
const parametersSchema = z.object({
  projectId: z.string().min(1).max(128),
  versionId: z.string().min(1).max(128),
  batchId: z.string().min(1).max(160),
});

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { projectId, versionId, batchId } = parametersSchema.parse(await context.params);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "run.read", projectId);
    const batch = await services.runBatches.getMetadata(batchId, [projectId]);
    if (
      batch.policy?.projectVersionId !== versionId ||
      batch.kind !== "standard" ||
      !batch.suiteId.startsWith("single:")
    ) {
      throw new DomainError("RUN_BATCH_NOT_FOUND", "指定版本中不存在该单用例执行记录。");
    }
    const [execution] = await services.singleCaseExecutionEntries([batchId]);
    return NextResponse.json(
      {
        batchId,
        status: batch.status,
        execution: execution ?? null,
        logsUrl: execution?.attempt
          ? `/api/v1/run-attempts/${encodeURIComponent(execution.attempt.id)}/logs`
          : null,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
