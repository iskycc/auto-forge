import { NextResponse } from "next/server";
import { z } from "zod";
import { createVersionCaseExecutionSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export type VersionCaseExecutionParams = { projectId: string; versionId: string; stageId?: string };
const scopeSchema = z.object({
  projectId: z.string().min(1).max(128),
  versionId: z.string().min(1).max(128),
  stageId: z.string().min(1).max(128).optional(),
});

export async function createVersionCaseExecutionResponse(
  request: Request,
  params: Promise<VersionCaseExecutionParams>,
): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId, versionId, stageId } = scopeSchema.parse(await params);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "run.create", projectId);
    const input = createVersionCaseExecutionSchema.parse(await readJsonBody(request, 64 * 1024));
    const structure = await services.projectStructures.list(projectId);
    const version = structure.versions.find(
      (entry) => entry.id === versionId && entry.status === "active",
    );
    if (
      !version ||
      (stageId &&
        !version.stages.some((stage) => stage.id === stageId && stage.status === "active"))
    ) {
      throw new DomainError(
        "CASE_SCOPE_NOT_FOUND",
        "指定版本或测试阶段不存在、不属于当前项目或已归档。",
      );
    }
    const batch = await services.runBatches.createVersionCaseExecution(
      projectId,
      versionId,
      input,
      {
        username: identity.user.username,
        source: identity.user.source,
      },
      ...(stageId ? ([{ testStageId: stageId }] as const) : []),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "execution.version_case_create",
      resourceType: "run_batch",
      resourceId: batch.id,
      projectId,
      requestId: currentRequestId,
      details: {
        projectVersionId: versionId,
        ...(stageId ? { testStageId: stageId } : {}),
        kind: "caseId" in input ? "ddt" : "testng",
      },
    });
    return NextResponse.json(
      {
        batchId: batch.id,
        sequenceNumber: batch.sequenceNumber,
        status: batch.status,
        statusUrl: `/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/case-executions/${encodeURIComponent(batch.id)}`,
        recordsUrl: "/execution-records?view=single",
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
