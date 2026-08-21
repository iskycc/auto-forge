import { z } from "zod";
import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";

import { authenticateRequest, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { SELECTED_PROJECT_COOKIE_NAME, selectableProjectIds } from "@/lib/selected-project";
import { getPlatformServices } from "@/lib/services";

const inputSchema = z.object({ projectId: z.string().trim().min(1).max(128) }).strict();

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { projectId } = inputSchema.parse(await readJsonBody(request, 2_048));
    const services = await getPlatformServices();
    const projects = await services.identities.listProjects(selectableProjectIds(identity));
    if (!projects.some((project) => project.id === projectId)) {
      throw new DomainError("AUTH_FORBIDDEN", "当前账号不能访问指定项目。");
    }
    const response = NextResponse.json({ projectId });
    response.cookies.set({
      name: SELECTED_PROJECT_COOKIE_NAME,
      value: projectId,
      httpOnly: true,
      sameSite: "strict",
      secure:
        request.headers.get("x-forwarded-proto") === "https" ||
        new URL(request.url).protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
