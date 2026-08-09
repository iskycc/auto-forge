import { runnerRegistrationInputSchema } from "@autoforge/contracts";
import { apiErrorResponse, bearerToken, readJsonBody, rejectRateLimited } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";
import { NextResponse } from "next/server";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = runnerRegistrationInputSchema.parse(await readJsonBody(request, 64 * 1024));
    const services = await getPlatformServices();
    rejectRateLimited(await services.runnerRequestLimiter.allow("runner:register:v1", 10, 60_000));
    const registration = await services.runnerControl.register(bearerToken(request), input);
    return NextResponse.json(registration.result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
