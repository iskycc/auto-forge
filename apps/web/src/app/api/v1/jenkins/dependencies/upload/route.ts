import { jenkinsDependencyUploadTargetSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { stageRuntimeArchive } from "@/lib/runtime-archive-upload";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const query = new URL(request.url).searchParams;
    const target = jenkinsDependencyUploadTargetSchema.parse({
      projectId: query.get("projectId"),
      version: query.get("version"),
      archiveFormat: query.get("archiveFormat") ?? "zip",
      sha256: request.headers.get("x-autoforge-sha256"),
    });
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "project.manage", target.projectId);
    const upload = await stageRuntimeArchive(
      request,
      target.archiveFormat,
      join(services.config.dataDirectory, "upload-staging"),
    );
    try {
      if (upload.sha256 !== target.sha256)
        throw new DomainError(
          "RUNTIME_ASSET_UPLOAD_INVALID",
          "上传依赖的 SHA-256 与文件摘要不一致，请确认构建文件没有被并发修改后重试。",
        );
      const replaced = await services.projectStructures.replaceUploadedVersionDependency({
        ...target,
        fileName: upload.fileName,
        sizeBytes: upload.sizeBytes,
        content: upload.content,
        actorId: identity.user.id,
      });
      await services.identityAccess.recordAuthorizedOperation(identity, {
        action: "jenkins.project_dependency.upload",
        resourceType: "project_version",
        resourceId: replaced.version.id,
        projectId: target.projectId,
        requestId: currentRequestId,
        details: {
          version: replaced.version.name,
          assetId: replaced.asset.id,
          fileName: upload.fileName,
          sizeBytes: upload.sizeBytes,
          sha256: upload.sha256,
        },
      });
      return NextResponse.json(
        {
          projectId: target.projectId,
          projectVersionId: replaced.version.id,
          version: replaced.version.name,
          assetId: replaced.asset.id,
          replaced: true,
          sourceType: "upload",
          fileName: upload.fileName,
          sha256: upload.sha256,
          sizeBytes: upload.sizeBytes,
        },
        { status: 201 },
      );
    } finally {
      await upload.dispose();
    }
  } catch (cause) {
    return apiErrorResponse(cause, currentRequestId);
  }
}
