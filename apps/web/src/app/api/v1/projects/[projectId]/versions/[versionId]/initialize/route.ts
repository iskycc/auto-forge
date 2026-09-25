import { NextResponse } from "next/server";
import { z } from "zod";
import {
  versionInitializationInputSchema,
  versionInitializationResultSchema,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import {
  authenticateRequest,
  authorizedProjectScope,
  requestId,
  requireSameOrigin,
} from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { workDispatcher } from "@/lib/work-runtime";

type Context = { params: Promise<{ projectId: string; versionId: string }> };

export async function GET(request: Request, context: Context) {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    authorizedProjectScope(identity, "case_suite.read", projectId);
    const query = z
      .object({
        sourceProjectVersionId: z.string().min(1).max(128),
        cursor: z.string().min(1).max(128).optional(),
      })
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const services = await getPlatformServices();
    const structure = await services.projectStructures.list(projectId);
    if (
      ![versionId, query.sourceProjectVersionId].every((id) =>
        structure.versions.some((version) => version.id === id),
      )
    )
      throw new DomainError("VERSION_INITIALIZATION_SCOPE_INVALID", "版本不属于当前项目。");
    return NextResponse.json(
      await services.caseSuites.listVersionPage(
        projectId,
        query.sourceProjectVersionId,
        query.cursor,
      ),
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function POST(request: Request, context: Context) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId, versionId } = await context.params;
    authorizedProjectScope(identity, "project.manage", projectId);
    const input = versionInitializationInputSchema.parse(await readJsonBody(request, 256 * 1_024));
    if (
      ["testng", "ddt", "range", "categories", "sr"].includes(input.step) ||
      (input.step === "suite" && input.includeCases)
    ) {
      authorizedProjectScope(identity, "case.read", projectId);
      authorizedProjectScope(identity, "case.manage", projectId);
    }
    if (input.step === "testng") authorizedProjectScope(identity, "case_source.manage", projectId);
    if (input.step === "suite") {
      authorizedProjectScope(identity, "case_suite.read", projectId);
      authorizedProjectScope(identity, "case_suite.manage", projectId);
    }
    const dispatcher = workDispatcher();
    if (!dispatcher?.initializeVersion)
      throw new DomainError("PLATFORM_BUSY", "初始化工作线程暂时不可用，请稍后继续。");
    const result = versionInitializationResultSchema.parse(
      await dispatcher.initializeVersion(
        {
          projectId,
          targetVersionId: versionId,
          input,
          ...(identity.sessionId.startsWith("api-token:") ? {} : { actorId: identity.user.id }),
        },
        request.signal,
      ),
    );
    const services = await getPlatformServices();
    await services.readModels.invalidate(projectId);
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "project_version.initialize",
      resourceType: "project_version",
      resourceId: versionId,
      projectId,
      requestId: currentRequestId,
      details: {
        sourceProjectVersionId: input.sourceProjectVersionId,
        step: input.step,
        inheritedCount: result.inheritedCount,
        skippedCount: result.skippedCount,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
