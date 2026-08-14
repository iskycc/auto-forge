import { createHash } from "node:crypto";

import { runtimeAssetUploadMetadataSchema } from "@autoforge/contracts";
import { DomainError, type RuntimeArchiveFormat } from "@autoforge/domain";
import { NextResponse } from "next/server";

import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse, readRuntimeArchiveUpload } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const url = new URL(request.url);
    const metadata = runtimeAssetUploadMetadataSchema.parse({
      kind: url.searchParams.get("kind"),
      archiveFormat: url.searchParams.get("archiveFormat"),
    });
    const services = await getPlatformServices();
    const upload = await readRuntimeArchiveUpload(request, services.config.maxJarBytes);
    assertRuntimeArchive(upload.fileName, upload.content, metadata.archiveFormat);
    const sha256 = createHash("sha256").update(upload.content).digest("hex");
    return NextResponse.json(
      await services.projectStructures.createUploadedAsset({
        projectId,
        kind: metadata.kind,
        archiveFormat: metadata.archiveFormat,
        ...upload,
        sha256,
        actorId: identity.user.id,
      }),
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

function assertRuntimeArchive(
  fileName: string,
  content: Uint8Array,
  archiveFormat: RuntimeArchiveFormat,
): void {
  const lowerName = fileName.toLowerCase();
  const validName =
    archiveFormat === "zip"
      ? lowerName.endsWith(".zip")
      : lowerName.endsWith(".tar.gz") || lowerName.endsWith(".tgz");
  const validSignature =
    archiveFormat === "zip"
      ? content[0] === 0x50 && content[1] === 0x4b
      : content[0] === 0x1f && content[1] === 0x8b;
  if (!validName || !validSignature) {
    throw new DomainError(
      "RUNTIME_ASSET_FORMAT_INVALID",
      `上传文件不是有效的 ${archiveFormat} 压缩包或扩展名不匹配。`,
    );
  }
}
