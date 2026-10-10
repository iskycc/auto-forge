import { cancelExecutionInputSchema } from "@autoforge/contracts";
import { isTerminalAttemptStatus } from "@autoforge/domain";
import { NextResponse } from "next/server";
import { authenticateRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ attemptId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authenticateRequest(request);
    const { attemptId } = await context.params;
    const input = cancelExecutionInputSchema.parse(await readJsonBody(request, 8 * 1024));
    const services = await getPlatformServices();
    const attempt = await services.runBatches.getManualAttemptContext(attemptId);
    services.identityAccess.authorize(identity, "log.read", attempt.projectId);
    services.identityAccess.authorize(identity, "run.cancel", attempt.projectId);
    if (isTerminalAttemptStatus(attempt.status)) {
      return NextResponse.json({ attemptId, cancelled: false, status: attempt.status });
    }
    await services.executionControl.cancelRun(
      identity.user.id,
      attempt.executionRunId,
      input.reason,
      services.identityAccess.projectScope(identity, "run.cancel"),
    );
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "run_attempt.manual_cancel",
      projectId: attempt.projectId,
      resourceType: "run_attempt",
      resourceId: attemptId,
      requestId: currentRequestId,
      details: { executionRunId: attempt.executionRunId },
    });
    return NextResponse.json({ attemptId, cancelled: true });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
