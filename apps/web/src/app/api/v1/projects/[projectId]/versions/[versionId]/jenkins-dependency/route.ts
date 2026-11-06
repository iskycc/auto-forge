import {
  jenkinsDependencyViewSchema,
  saveJenkinsDependencyConfigurationSchema,
} from "@autoforge/contracts";
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
export async function GET(request: Request, context: Context) {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const services = await getPlatformServices();
    const view = await services.jenkinsDependencyBuilds.read(
      projectId,
      versionId,
      new URL(request.url).searchParams.get("refresh") === "1",
    );
    return NextResponse.json(jenkinsDependencyViewSchema.parse(view), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
export async function PUT(request: Request, context: Context) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const input = saveJenkinsDependencyConfigurationSchema.parse(
      await readJsonBody(request, 256 * 1024),
    );
    const services = await getPlatformServices();
    const view = await services.jenkinsDependencyBuilds.save(projectId, versionId, input);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "project_version.jenkins_configure",
      resourceType: "project_version",
      resourceId: versionId,
      projectId,
      requestId: currentRequestId,
      details: { parameterCount: input.parameters.length },
    });
    return NextResponse.json(jenkinsDependencyViewSchema.parse(view), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
