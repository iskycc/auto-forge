import { projectAdapterConfigurationInputSchema } from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { z } from "zod";
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

const deleteQuerySchema = z.object({
  kind: z.enum(["jdk", "jar-bundle"]),
  expectedRevision: z.coerce.number().int().nonnegative(),
});

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.read", projectId);
    return NextResponse.json(
      await (await getPlatformServices()).projectStructures.list(projectId).then((structure) => {
        const version = structure.versions.find((candidate) => candidate.id === versionId);
        if (!version) throw new DomainError("PROJECT_VERSION_NOT_FOUND", "指定的项目版本不存在。");
        return version.adapterConfiguration;
      }),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function PUT(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const input = projectAdapterConfigurationInputSchema.parse(
      await readJsonBody(request, 32 * 1_024),
    );
    const services = await getPlatformServices();
    const configuration = await services.projectStructures.updateAdapterConfiguration(
      projectId,
      input,
      identity.user.id,
      versionId,
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "project_version.runtime_update",
      resourceType: "project_version",
      resourceId: versionId,
      projectId,
      requestId: currentRequestId,
      details: {
        jdkConfigured: Boolean(configuration.jdkAsset),
        jarBundleConfigured: Boolean(configuration.jarBundleAsset),
      },
    });
    return NextResponse.json(configuration);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const input = deleteQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const configuration = await services.projectStructures.deleteVersionRuntimeAsset({
      projectId,
      projectVersionId: versionId,
      kind: input.kind,
      expectedRevision: input.expectedRevision,
      actorId: identity.user.id,
    });
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "project_version.runtime_delete",
      resourceType: "project_version",
      resourceId: versionId,
      projectId,
      requestId: currentRequestId,
      details: { kind: input.kind },
    });
    return NextResponse.json(configuration);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
