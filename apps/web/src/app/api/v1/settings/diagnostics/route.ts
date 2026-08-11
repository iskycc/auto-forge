import { systemDiagnosticSchema, type SystemDiagnostic } from "@autoforge/contracts";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/api-response";
import { authorizeRequest } from "@/lib/auth";
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
    const dataDisk = await readDiskCapacity(services.config.dataDirectory);
    const generatedAt = new Date().toISOString();
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
    if (dataDisk.status !== "ok") {
      recentErrors.push({
        timestamp: generatedAt,
        code: dataDisk.status === "critical" ? "DATA_DISK_CRITICAL" : "DATA_DISK_WARNING",
        summary: `平台数据卷已使用 ${dataDisk.usedPercent}%，可用 ${formatBytes(dataDisk.availableBytes)}。`,
      });
    }
    const diagnostic = systemDiagnosticSchema.parse({
      generatedAt,
      mode: services.config.mode,
      version: platformVersion,
      configurationRevision: services.configurationStore.read().revision,
      database: toView(checks[0]!),
      objectStore: toView(checks[1]!),
      queue: toView(
        checks[2]!,
        queueDepth ? `可用 ${queueDepth.available} / 租约 ${queueDepth.leased}` : undefined,
      ),
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
