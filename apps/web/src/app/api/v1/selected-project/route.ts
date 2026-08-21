import { z } from "zod";
import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";

import { authenticateRequest, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import {
  SELECTED_PROJECT_COOKIE_NAME,
  SELECTED_PROJECT_VERSION_COOKIE_NAME,
  SELECTED_TEST_STAGE_COOKIE_NAME,
  selectableProjectIds,
} from "@/lib/selected-project";
import { getPlatformServices } from "@/lib/services";

const inputSchema = z
  .object({
    projectId: z.string().trim().min(1).max(128),
    projectVersionId: z.string().trim().min(1).max(128).optional(),
    testStageId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const input = inputSchema.parse(await readJsonBody(request, 2_048));
    const services = await getPlatformServices();
    const projects = await services.identities.listProjects(selectableProjectIds(identity));
    if (!projects.some((project) => project.id === input.projectId)) {
      throw new DomainError("AUTH_FORBIDDEN", "当前账号不能访问指定项目。");
    }
    const structure = await services.projectStructures.list(input.projectId);
    const activeVersions = structure.versions.filter((version) => version.status === "active");
    const version = input.projectVersionId
      ? activeVersions.find((candidate) => candidate.id === input.projectVersionId)
      : activeVersions[0];
    if (input.projectVersionId && !version) {
      throw new DomainError("PROJECT_VERSION_NOT_FOUND", "指定项目版本不存在或已归档。");
    }
    const activeStages = version?.stages.filter((stage) => stage.status === "active") ?? [];
    const stage = input.testStageId
      ? activeStages.find((candidate) => candidate.id === input.testStageId)
      : activeStages[0];
    if (input.testStageId && !stage) {
      throw new DomainError("TEST_STAGE_NOT_FOUND", "指定测试阶段不属于当前版本或已归档。");
    }
    const response = NextResponse.json({
      projectId: input.projectId,
      ...(version ? { projectVersionId: version.id } : {}),
      ...(stage ? { testStageId: stage.id } : {}),
    });
    const secure =
      request.headers.get("x-forwarded-proto") === "https" ||
      new URL(request.url).protocol === "https:";
    setContextCookie(response, SELECTED_PROJECT_COOKIE_NAME, input.projectId, secure);
    setContextCookie(response, SELECTED_PROJECT_VERSION_COOKIE_NAME, version?.id, secure);
    setContextCookie(response, SELECTED_TEST_STAGE_COOKIE_NAME, stage?.id, secure);
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}

function setContextCookie(
  response: NextResponse,
  name: string,
  value: string | undefined,
  secure: boolean,
): void {
  response.cookies.set({
    name,
    value: value ?? "",
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: value ? 60 * 60 * 24 * 365 : 0,
  });
}
