import { NextResponse } from "next/server";
import { z } from "zod";
import { assertVersionCopyAccess, publicVersionCopy } from "@autoforge/application";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ copyId: string }> };
export async function GET(request: Request, context: Context) {
  const id = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { copyId } = await context.params;
    const job = await (await getPlatformServices()).versionCopies.get(copyId);
    assertVersionCopyAccess(identity, job.sourceProjectId, job.targetProjectId);
    return NextResponse.json(publicVersionCopy(job));
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
export async function POST(request: Request, context: Context) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { copyId } = await context.params;
    const { action } = z
      .object({ action: z.enum(["retry", "cancel"]) })
      .strict()
      .parse(await readJsonBody(request, 1024));
    const services = await getPlatformServices();
    const job = await services.versionCopies.action(copyId, action, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: `project_version.copy_${action}`,
      resourceType: "project_version_copy",
      resourceId: copyId,
      projectId: job.sourceProjectId,
      requestId: id,
      details: { targetProjectId: job.targetProjectId },
    });
    return NextResponse.json(job, { status: 202 });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
