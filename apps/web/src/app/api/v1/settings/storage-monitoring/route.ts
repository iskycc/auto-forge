import { NextResponse } from "next/server";
import { DomainError } from "@autoforge/domain";
import { storageMonitoringTargetSchema } from "@autoforge/contracts";
import { apiErrorResponse, readJsonBody } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request) {
  const currentRequestId = requestId(request);
  try {
    const identity = await authorizeRequest(request, "settings.read", undefined);
    const query = new URL(request.url).searchParams;
    const target = storageMonitoringTargetSchema.parse({
      kind: query.get("kind"),
      ...(query.has("databaseId") ? { databaseId: query.get("databaseId") } : {}),
    });
    const services = await getPlatformServices();
    if (!services.storageMonitoring)
      throw new DomainError(
        "STORAGE_MONITORING_UNSUPPORTED",
        "当前部署使用本地磁盘信息，无需配置 Node Exporter。",
      );
    return NextResponse.json(await services.storageMonitoring.read(identity, target), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

export async function PUT(request: Request) {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage", undefined);
    const services = await getPlatformServices();
    if (!services.storageMonitoring)
      throw new DomainError("STORAGE_MONITORING_UNSUPPORTED", "当前部署无需配置 Node Exporter。");
    const saved = await services.storageMonitoring.save(
      identity,
      await readJsonBody(request, 8192),
    );
    services.logDatabases?.invalidateCapacity();
    await services.identityAccess.recordAuthorizedOperation(identity, {
      action: "storage_monitoring.update",
      resourceType: "storage_monitoring",
      resourceId: saved.target.kind === "primary" ? "primary" : saved.target.databaseId,
      requestId: currentRequestId,
      details: { enabled: !!saved.source },
    });
    return NextResponse.json(saved, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
