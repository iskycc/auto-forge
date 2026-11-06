import { triggerJenkinsDependencyBuildSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ projectId: string; versionId: string }> };
export async function POST(request: Request, context: Context) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const services = await getPlatformServices();
    const input = triggerJenkinsDependencyBuildSchema.parse(await readJsonBody(request, 2048));
    const result = await services.jenkinsDependencyBuilds.trigger(
      projectId,
      versionId,
      input,
      identity.user.username,
    );
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
