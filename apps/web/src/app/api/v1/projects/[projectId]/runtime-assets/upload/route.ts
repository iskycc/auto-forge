import { runtimeAssetUploadMetadataSchema } from "@autoforge/contracts";
import { join } from "node:path";
import { NextResponse } from "next/server";

import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { stageRuntimeArchive } from "@/lib/runtime-archive-upload";
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
    const upload = await stageRuntimeArchive(
      request,
      metadata.archiveFormat,
      join(services.config.dataDirectory, "upload-staging"),
    );
    try {
      return NextResponse.json(
        await services.projectStructures.createUploadedAsset({
          projectId,
          kind: metadata.kind,
          archiveFormat: metadata.archiveFormat,
          fileName: upload.fileName,
          content: upload.content,
          sizeBytes: upload.sizeBytes,
          sha256: upload.sha256,
          actorId: identity.user.id,
        }),
        { status: 201 },
      );
    } finally {
      await upload.dispose();
    }
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
