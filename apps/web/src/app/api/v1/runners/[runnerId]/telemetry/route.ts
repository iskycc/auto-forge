import { NextResponse } from "next/server";
import { authorizeRequest, requestId } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request, context: { params: Promise<{ runnerId: string }> }) {
  const currentRequestId = requestId(request);
  try {
    await authorizeRequest(request, "runner.read");
    const { runnerId } = await context.params;
    const services = await getPlatformServices();
    return NextResponse.json(await services.runnerControl.telemetry(runnerId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
