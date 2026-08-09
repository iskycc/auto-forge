import { DomainError } from "@autoforge/domain";

import { apiErrorResponse, bearerToken, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string; inputId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const runnerId = request.headers.get("x-autoforge-runner-id")?.trim();
    const leaseToken = request.headers.get("x-autoforge-lease-token")?.trim();
    if (!runnerId) throw new DomainError("RUNNER_AUTH_REQUIRED", "缺少执行机标识。");
    if (!leaseToken) throw new DomainError("LEASE_AUTH_REQUIRED", "缺少任务租约凭据。");
    const { attemptId, inputId } = await context.params;
    const services = await getPlatformServices();
    rejectRateLimited(
      await services.runnerRequestLimiter.allow(`runner:input:v1:${runnerId}`, 120, 60_000),
    );
    const authorized = await services.executionControl.resolveInput(
      runnerId,
      bearerToken(request),
      attemptId,
      inputId,
      leaseToken,
    );
    const content = await services.objectStore.read(authorized.objectKey);
    if (content.byteLength !== authorized.sizeBytes) {
      throw new DomainError("ATTEMPT_INPUT_CORRUPTED", "输入对象大小与登记信息不一致。");
    }
    return new Response(Uint8Array.from(content).buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="tests.jar"',
        "Content-Length": String(content.byteLength),
        "Content-Type": "application/java-archive",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
