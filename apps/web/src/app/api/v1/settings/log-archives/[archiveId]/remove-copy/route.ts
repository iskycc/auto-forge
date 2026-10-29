import { NextResponse } from "next/server";
import { z } from "zod";
import { removeLogArchiveCopySchema } from "@autoforge/contracts";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
export async function POST(request: Request, context: { params: Promise<{ archiveId: string }> }) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    await authorizeRequest(request, "log.read", undefined);
    const input = removeLogArchiveCopySchema.parse(await readJsonBody(request, 1024));
    const archiveId = z
      .string()
      .uuid()
      .parse((await context.params).archiveId);
    const services = await getPlatformServices();
    await services.logArchives.removeCopy(archiveId, identity.user.id, input.sha256);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "platform.log_archive_copy_removal_requested",
      resourceType: "log_archive",
      resourceId: archiveId,
      requestId: id,
      details: { downloadedAndVerified: true, sha256: input.sha256 },
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
