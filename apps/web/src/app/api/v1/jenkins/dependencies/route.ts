import { jenkinsDependencyPublicationInputSchema } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = jenkinsDependencyPublicationInputSchema.parse(
      await readJsonBody(request, 32 * 1024),
    );
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "project.manage", input.projectId);
    const replaced = await services.projectStructures.replaceVersionDependency(
      input,
      identity.user.id,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "jenkins.project_dependency.replace",
      resourceType: "project_version",
      resourceId: replaced.version.id,
      projectId: input.projectId,
      requestId: currentRequestId,
      details: {
        version: replaced.version.name,
        assetId: replaced.asset.id,
        sizeBytes: replaced.asset.sizeBytes,
      },
    });
    return NextResponse.json({
      projectId: input.projectId,
      projectVersionId: replaced.version.id,
      version: replaced.version.name,
      assetId: replaced.asset.id,
      replaced: true,
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
