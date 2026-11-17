import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse, bearerToken, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { admitRunnerProtocolResource } from "@/lib/runner-protocol-admission";

export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }) {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
    const { attemptId } = await context.params;
    const services = await getPlatformServices();
    await admitRunnerProtocolResource(
      services.runnerRequestLimiter,
      "upload-phase",
      runnerId,
      attemptId,
    );
    return NextResponse.json(
      await services.runnerProtocol.beginUpload(
        runnerId,
        bearerToken(request),
        attemptId,
        await readJsonBody(request, 4096),
      ),
    );
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
