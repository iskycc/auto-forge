import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function POST(request: Request) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    const services = await getPlatformServices();
    if (!services.storageMonitoring)
      throw new DomainError("STORAGE_MONITORING_UNSUPPORTED", "当前部署无需配置 Node Exporter。");
    return NextResponse.json(
      await services.storageMonitoring.check(identity, await readJsonBody(request, 4096)),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
