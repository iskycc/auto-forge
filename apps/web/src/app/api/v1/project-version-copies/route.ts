import { NextResponse } from "next/server";
import { z } from "zod";
import { canCopyProjectVersion } from "@autoforge/application";
import { createProjectVersionCopySchema } from "@autoforge/contracts";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const projectId = z
      .string()
      .min(1)
      .max(128)
      .parse(new URL(request.url).searchParams.get("projectId"));
    authorizedProjectScope(identity, "project.manage", projectId);
    const services = await getPlatformServices();
    const parameters = new URL(request.url).searchParams;
    if (parameters.has("targetProjectId")) {
      const targetProjectId = z.string().min(1).max(128).parse(parameters.get("targetProjectId"));
      const afterId = z
        .string()
        .min(1)
        .max(128)
        .optional()
        .parse(parameters.get("afterId") ?? undefined);
      return NextResponse.json(
        await services.versionCopies.listTargets(
          projectId,
          targetProjectId,
          identity.user.id,
          afterId,
        ),
      );
    }
    const projects = await services.identityAccess.listProjects(identity);
    const targets = projects
      .filter(
        (project) => !project.archived && canCopyProjectVersion(identity, projectId, project.id),
      )
      .map(({ id, name }) => ({ id, name }));
    const jobs = (
      await services.versionCopies.list(
        projects.map((project) => project.id),
        projectId,
      )
    ).filter((job) => canCopyProjectVersion(identity, job.sourceProjectId, job.targetProjectId));
    return NextResponse.json({ targets, jobs });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}

export async function POST(request: Request) {
  const id = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = createProjectVersionCopySchema.parse(await readJsonBody(request, 8192));
    const services = await getPlatformServices();
    const job = await services.versionCopies.create(input, identity.user.id);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "project_version.copy",
      resourceType: "project_version_copy",
      resourceId: job.id,
      projectId: input.sourceProjectId,
      requestId: id,
      details: {
        sourceVersionId: input.sourceVersionId,
        targetProjectId: input.targetProjectId,
        targetVersionName: job.targetVersionName,
        targetMode: job.targetMode,
        ...(input.targetVersionId ? { targetVersionId: input.targetVersionId } : {}),
      },
    });
    return NextResponse.json(job, { status: 202 });
  } catch (cause) {
    return apiErrorResponse(cause, id);
  }
}
