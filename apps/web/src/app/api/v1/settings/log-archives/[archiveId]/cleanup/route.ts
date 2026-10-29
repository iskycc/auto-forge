import { NextResponse } from "next/server";
import { z } from "zod";
import { cleanupLogArchiveSchema } from "@autoforge/contracts";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
export async function POST(request: Request, context: { params: Promise<{ archiveId: string }> }) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    cleanupLogArchiveSchema.parse(await readJsonBody(request, 1024));
    const archiveId = z
      .string()
      .uuid()
      .parse((await context.params).archiveId);
    const services = await getPlatformServices();
    await services.logArchives.cleanup(archiveId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "platform.log_archive_cleanup_requested",
      resourceType: "log_archive",
      resourceId: archiveId,
      requestId: id,
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
