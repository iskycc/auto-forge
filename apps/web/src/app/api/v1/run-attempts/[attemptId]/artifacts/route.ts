import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { authenticateRequest } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { DomainError } from "@autoforge/domain";

type Context = { params: Promise<{ attemptId: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const identity = await authenticateRequest(request);
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    const projectIds = services.identityAccess.projectScope(identity, "artifact.read");
    const artifacts = await services.executionControl.listArtifacts(attemptId, projectIds);
    return NextResponse.json({
      items: artifacts.map(({ objectKey, ...artifact }) => ({
        ...artifact,
        ...(artifact.status === "uploaded" && objectKey
          ? {
              downloadPath: `/api/v1/run-attempts/${encodeURIComponent(attemptId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
            }
          : {}),
      })),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:artifacts:v1:${runnerId}`, 120, 60_000),
    );
    return NextResponse.json(
      await services.runnerProtocol.declareArtifacts(
        runnerId,
        bearerToken(request),
        attemptId,
        await readJsonBody(request, 512 * 1024),
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
