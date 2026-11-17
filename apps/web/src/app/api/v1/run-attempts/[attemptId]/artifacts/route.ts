import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";
import { declareArtifactsInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, bearerToken, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { admitRunnerProtocolResource } from "@/lib/runner-protocol-admission";

// Adjacent protocol-v1 Agents used an empty declaration to start the log-upload clock.
// Only this timing handshake survives; no artifact is accepted or stored.
export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }) {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
    const { attemptId } = await context.params;
    const input = declareArtifactsInputSchema.parse(await readJsonBody(request, 512 * 1024));
    const services = await getPlatformServices();
    await admitRunnerProtocolResource(
      services.runnerRequestLimiter,
      "upload-phase",
      runnerId,
      attemptId,
    );
    await services.runnerProtocol.beginUpload(runnerId, bearerToken(request), attemptId, input);
    if (input.artifacts.length)
      throw new DomainError(
        "EXECUTION_ARTIFACTS_RETIRED",
        "执行产物上传已移除，请更新执行节点 Agent；用例结果和日志继续保留。",
      );
    return NextResponse.json({ schemaVersion: 1, artifacts: [] });
  } catch (cause) {
    return apiErrorResponse(cause);
  }
}
