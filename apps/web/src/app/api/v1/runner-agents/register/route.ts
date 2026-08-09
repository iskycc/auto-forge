import { runnerRegistrationInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";
import { requestId } from "@/lib/auth";

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const input = runnerRegistrationInputSchema.parse(await readJsonBody(request, 64 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(await services.runnerRequestLimiter.allow("runner:register:v1", 10, 60_000));
    const registration = await services.runnerControl.register(bearerToken(request), input);
    await services.identityAccess.recordRunnerOperation({
      runnerId: registration.runner.id,
      action: "runner.register",
      requestId: currentRequestId,
      details: { name: registration.runner.name },
    });
    return NextResponse.json(registration.result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
