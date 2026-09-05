import { systemDiagnosticSchema, type SystemDiagnostic } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest, requestId, requireSameOrigin } from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { platformVersion } from "@/lib/version";
import { readDiskCapacity } from "@/lib/disk-capacity";

const CHECK_TIMEOUT_MS = 3_000;

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await authorizeRequest(request, "settings.read");
    const services = await getPlatformServices();
    const checks = await Promise.all([
      health("database", () => services.catalog.getDashboardSummary()),
      health("object-store", () => services.objectStore.ready()),
      health("queue", () => services.jobQueue.ready()),
      health("cache", () => services.cache.get("diagnostics", "system", 1, "readiness")),
    ]);
    const queueDepth = checks[2]?.ready ? await services.jobQueue.depth() : undefined;
    const deadLetters =
      queueDepth && queueDepth.deadLetter > 0 ? await services.jobQueue.listDeadLetters(20) : [];
    const dataDisk = await readDiskCapacity(services.config.dataDirectory);
    const generatedAt = services.clock.now().toISOString();
    const clock = {
      ...services.clock.status(),
      hostOffsetMs: Date.now() - Date.parse(generatedAt),
    };
    const recentErrors: SystemDiagnostic["recentErrors"] = checks
      .filter((check) => !check.ready)
      .map((check) => ({
        timestamp: generatedAt,
        code: `${check.name.toUpperCase().replaceAll("-", "_")}_UNAVAILABLE`,
        summary: check.detail,
      }));
    if (queueDepth && queueDepth.deadLetter > 0) {
      recentErrors.push({
        timestamp: generatedAt,
        code: "QUEUE_DEAD_LETTER_PRESENT",
        summary: `队列中有 ${queueDepth.deadLetter} 个死信任务。`,
      });
    }
    if (clock.state === "holdover" || Math.abs(clock.hostOffsetMs) >= 5_000) {
      recentErrors.push({
        timestamp: generatedAt,
        code: clock.state === "holdover" ? "PLATFORM_CLOCK_HOLDOVER" : "HOST_CLOCK_SKEW",
        summary:
          clock.state === "holdover"
            ? "统一时间采样暂不可用，正在按单调时钟继续计时；120 秒内需要恢复采样。"
            : `本机系统时间比平台时间${clock.hostOffsetMs > 0 ? "快" : "慢"} ${Math.round(Math.abs(clock.hostOffsetMs) / 1_000)} 秒，请检查宿主机校时。`,
      });
    }
    if (dataDisk.status !== "ok") {
      recentErrors.push({
        timestamp: generatedAt,
        code: dataDisk.status === "critical" ? "DATA_DISK_CRITICAL" : "DATA_DISK_WARNING",
        summary: `平台数据卷已使用 ${dataDisk.usedPercent}%，可用 ${formatBytes(dataDisk.availableBytes)}。`,
      });
    }
    const diagnostic = systemDiagnosticSchema.parse({
      clock,
      generatedAt,
      mode: services.config.mode,
      version: platformVersion,
      configurationRevision: services.configurationStore.read().revision,
      database: toView(checks[0]!),
      objectStore: toView(checks[1]!),
      queue: toView(
        checks[2]!,
        queueDepth
          ? `可用 ${queueDepth.available} / 租约 ${queueDepth.leased} / 死信 ${queueDepth.deadLetter}`
          : undefined,
      ),
      deadLetters,
      cache: toView(checks[3]!),
      dataDisk,
      recentErrors: recentErrors.slice(0, 50),
    });
    const download = new URL(request.url).searchParams.get("download") === "1";
    return NextResponse.json(diagnostic, {
      ...(download
        ? {
            headers: {
              "Content-Disposition": `attachment; filename="autoforge-diagnostics-${generatedAt.slice(0, 10)}.json"`,
              "X-Content-Type-Options": "nosniff",
            },
          }
        : {}),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const currentRequestId = requestId(request);
  try {
    requireSameOrigin(request);
    const identity = await authorizeRequest(request, "settings.manage");
    const services = await getPlatformServices();
    const redriven = await services.jobQueue.redriveDeadLetters({
      redrivenAt: services.clock.now().toISOString(),
      limit: 100,
    });
    await services.identityAccess.recordQueueDeadLetterRedrive(
      identity,
      { redriven },
      currentRequestId,
    );
    return NextResponse.json({ redriven });
  } catch (error) {
    return apiErrorResponse(error, currentRequestId);
  }
}

type HealthCheck = { name: string; ready: boolean; detail: string };

async function health(name: string, operation: () => Promise<unknown>): Promise<HealthCheck> {
  try {
    await withTimeout(operation(), CHECK_TIMEOUT_MS);
    return { name, ready: true, detail: "ready" };
  } catch (error) {
    return {
      name,
      ready: false,
      detail: error instanceof Error ? redact(error.message) : "健康检查失败。",
    };
  }
}

function toView(check: HealthCheck, readyDetail?: string) {
  return { ready: check.ready, detail: check.ready ? (readyDetail ?? "ready") : check.detail };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("健康检查超时。")), timeoutMs);
    operation.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function redact(message: string): string {
  return message
    .replace(/(?:postgres(?:ql)?|redis|nats|https?):\/\/[^\s]+/gi, "[redacted-endpoint]")
    .replace(/(?:password|token|secret|credential)\s*[=:]\s*\S+/gi, "field=[redacted]")
    .slice(0, 500);
}

function formatBytes(value: number): string {
  if (value < 1_024 ** 3) return `${(value / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1_024 ** 3).toFixed(1)} GiB`;
}
