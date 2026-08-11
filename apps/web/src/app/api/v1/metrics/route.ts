import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authenticateRequest, requestId } from "@/lib/auth";
import { httpMetricsText } from "@/lib/runtime-metrics";
import { getPlatformServices } from "@/lib/services";

export async function GET(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    const identity = await authenticateRequest(request);
    const services = await getPlatformServices();
    services.identityAccess.authorize(identity, "settings.read");
    if (!services.config.metricsEnabled) {
      return NextResponse.json(
        {
          error: {
            code: "METRICS_DISABLED",
            message: "指标导出未启用。",
            requestId: currentRequestId,
          },
        },
        { status: 404 },
      );
    }
    const [snapshot, depth] = await Promise.all([
      services.platformOperations.operationalMetrics(identity),
      services.jobQueue.depth(),
    ]);
    const lines = [
      ...httpMetricsText(),
      "# TYPE autoforge_queue_jobs gauge",
      `autoforge_queue_jobs{state="available"} ${depth.available}`,
      `autoforge_queue_jobs{state="leased"} ${depth.leased}`,
      `autoforge_queue_jobs{state="dead_letter"} ${depth.deadLetter}`,
      "# TYPE autoforge_active_leases gauge",
      `autoforge_active_leases ${snapshot.activeLeases}`,
      "# TYPE autoforge_runner_slots gauge",
      `autoforge_runner_slots{state="capacity"} ${snapshot.runnerCapacity}`,
      `autoforge_runner_slots{state="busy"} ${snapshot.runnerBusySlots}`,
      "# TYPE autoforge_stored_log_bytes gauge",
      `autoforge_stored_log_bytes ${snapshot.storedLogBytes}`,
      "# TYPE autoforge_uploaded_artifacts gauge",
      `autoforge_uploaded_artifacts ${snapshot.uploadedArtifacts}`,
      "# TYPE autoforge_failed_attempts gauge",
      `autoforge_failed_attempts ${snapshot.failedAttempts}`,
      "# TYPE autoforge_cleanup_jobs gauge",
      `autoforge_cleanup_jobs{state="pending"} ${snapshot.pendingCleanupJobs}`,
      `autoforge_cleanup_jobs{state="dead_letter"} ${snapshot.deadLetterCleanupJobs}`,
      "",
    ];
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}
