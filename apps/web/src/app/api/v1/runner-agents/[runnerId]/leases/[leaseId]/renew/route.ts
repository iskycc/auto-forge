import { admitRunnerProtocolResource } from "@/lib/runner-protocol-admission";
import { NextResponse } from "next/server";

import { apiErrorResponse, bearerToken, readJsonBody } from "@/lib/api-response";
import { getPlatformServices } from "@/lib/services";

type Context = { params: Promise<{ runnerId: string; leaseId: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { runnerId, leaseId } = await context.params;
    const services = await getPlatformServices();
    await admitRunnerProtocolResource(
      services.runnerRequestLimiter,
      "renew-lease",
      runnerId,
      leaseId,
    );
    return NextResponse.json(
      await services.runnerProtocol.renewLease(
        runnerId,
        bearerToken(request),
        leaseId,
        await readJsonBody(request, 16 * 1024),
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
