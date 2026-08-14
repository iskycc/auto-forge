import { createHash } from "node:crypto";

import { DEFAULT_PROJECT_ID, DomainError } from "@autoforge/domain";
import { apiErrorResponse, readJarUpload } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    const requestedProjectId = new URL(request.url).searchParams.get("projectId")?.trim();
    const projectVersionId = new URL(request.url).searchParams.get("projectVersionId")?.trim();
    const testStageId = new URL(request.url).searchParams.get("testStageId")?.trim();
    const projectScope = authorizedProjectScope(
      identity,
      "case_source.manage",
      requestedProjectId || undefined,
    );
    const projectId = requestedProjectId || projectScope?.at(0) || DEFAULT_PROJECT_ID;
    const structure = await services.projectStructures.list(projectId);
    const selectedVersion = structure.versions.find((version) => version.id === projectVersionId);
    const selectedStage = selectedVersion?.stages.find((stage) => stage.id === testStageId);
    if (!selectedVersion || !selectedStage) {
      throw new DomainError(
        "CASE_IMPORT_STAGE_REQUIRED",
        "导入用例前必须选择当前项目下的版本和测试阶段。",
      );
    }
    const upload = await readJarUpload(request, services.config.maxJarBytes);
    const sha256 = createHash("sha256").update(upload.content).digest("hex");
    const requestedKey = request.headers.get("Idempotency-Key")?.trim();
    const result = await services.importTestNgJar.enqueue({
      ...upload,
      projectId,
      projectVersionId: selectedVersion.id,
      testStageId: selectedStage.id,
      actorId: identity.user.id,
      sha256,
      idempotencyKey: requestedKey || `stage:${selectedStage.id}:sha256:${sha256}`,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "case_source.import_queued",
      resourceType: "jar_import_job",
      resourceId: result.id,
      projectId,
      requestId: currentRequestId,
      details: { fileName: upload.fileName, sizeBytes: upload.content.byteLength },
    });
    return NextResponse.json(result, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
