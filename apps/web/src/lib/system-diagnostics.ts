import type { JobQueuePort, PlatformClock } from "@autoforge/application";
import { systemDiagnosticSchema, type SystemDiagnostic } from "@autoforge/contracts";

import { readDiskCapacity, type DiskCapacity } from "./disk-capacity";
import { platformBuild } from "./version";

type DependencyName = "database" | "objectStore" | "queue" | "cache";
type Probe = { provider: string; check(): Promise<unknown> };
type DiagnosticSources = {
  mode: "lite" | "full";
  clock: Pick<PlatformClock, "now" | "status">;
  configurationRevision(): number;
  dependencies: Record<DependencyName, Probe>;
  queue: Pick<JobQueuePort, "depth" | "listDeadLetters">;
  runtime(): NonNullable<SystemDiagnostic["runtime"]>;
  dataDirectory: string;
  disk?: (path: string) => Promise<DiskCapacity>;
};

const SNAPSHOT_TTL_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;

/** Per-node bounded snapshots: shared by concurrent readers, never by unrelated deployments. */
export class SystemDiagnosticReader {
  private cached?: { value: SystemDiagnostic; storedAt: number };
  private pending: Promise<SystemDiagnostic> | undefined;
  private readonly probes = new Map<string, Promise<unknown>>();

  constructor(private readonly sources: DiagnosticSources) {}

  read(refresh = false): Promise<SystemDiagnostic> {
    if (this.pending) return this.pending;
    if (!refresh && this.cached && performance.now() - this.cached.storedAt < SNAPSHOT_TTL_MS)
      return Promise.resolve(this.cached.value);
    this.pending = this.collect()
      .then((value) => {
        this.cached = { value, storedAt: performance.now() };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async collect(): Promise<SystemDiagnostic> {
    const dependencyNames: DependencyName[] = ["database", "objectStore", "queue", "cache"];
    const [checks, diskResult] = await Promise.all([
      Promise.all(
        dependencyNames.map(async (name) => {
          const source = this.sources.dependencies[name];
          const result = await this.probe(name, async () => {
            await source.check();
            if (name !== "queue") return undefined;
            const depth = await this.sources.queue.depth();
            const deadLetters =
              depth.deadLetter > 0 ? await this.sources.queue.listDeadLetters(20) : [];
            return { depth, deadLetters };
          });
          return { name, provider: source.provider, ...result };
        }),
      ),
      this.probe("disk", () => (this.sources.disk ?? readDiskCapacity)(this.sources.dataDirectory)),
    ]);
    const clockStatus = this.sources.clock.status();
    // A failed shared clock must remain diagnosable. This fallback is for this report only.
    const generatedAt =
      clockStatus.state === "unavailable"
        ? new Date().toISOString()
        : this.sources.clock.now().toISOString();
    const clock = { ...clockStatus, hostOffsetMs: Date.now() - Date.parse(generatedAt) };
    const recentErrors: SystemDiagnostic["recentErrors"] = [];
    const addError = (code: string, summary: string) =>
      recentErrors.push({ timestamp: generatedAt, code, summary });
    const dependencies = Object.fromEntries(
      checks.map((check) => {
        if (!check.ready)
          addError(
            `${check.name === "objectStore" ? "OBJECT_STORE" : check.name.toUpperCase()}_UNAVAILABLE`,
            check.detail,
          );
        return [
          check.name,
          {
            ready: check.ready,
            provider: check.provider,
            detail: check.detail,
            durationMs: check.durationMs,
          },
        ];
      }),
    );
    const queue = checks.find((check) => check.name === "queue")?.value;
    if (queue?.depth.deadLetter)
      addError(
        "QUEUE_DEAD_LETTER_PRESENT",
        `队列中有 ${queue.depth.deadLetter} 个死信任务，请检查失败原因后重新投递。`,
      );
    if (clock.state !== "synchronized") {
      addError(
        clock.state === "unavailable" ? "PLATFORM_CLOCK_UNAVAILABLE" : "PLATFORM_CLOCK_HOLDOVER",
        clock.state === "unavailable"
          ? "统一时间不可用，本报告临时使用宿主机时间；请检查 PostgreSQL 连接及时间。"
          : "统一时间采样暂不可用，正在按单调时钟继续计时；120 秒内需要恢复采样。",
      );
    } else if (Math.abs(clock.hostOffsetMs) >= 5_000) {
      addError(
        "HOST_CLOCK_SKEW",
        `本机时间比平台时间${clock.hostOffsetMs > 0 ? "快" : "慢"} ${Math.round(Math.abs(clock.hostOffsetMs) / 1_000)} 秒，请检查宿主机校时。`,
      );
    }
    if (!diskResult.ready) addError("DATA_DISK_UNAVAILABLE", diskResult.detail);
    else if (diskResult.value.status !== "ok")
      addError(
        diskResult.value.status === "critical" ? "DATA_DISK_CRITICAL" : "DATA_DISK_WARNING",
        `平台数据卷已使用 ${diskResult.value.usedPercent}%，请检查存储空间。`,
      );
    return systemDiagnosticSchema.parse({
      ...dependencies,
      generatedAt,
      clock,
      version: platformBuild.version,
      build: platformBuild,
      mode: this.sources.mode,
      configurationRevision: this.sources.configurationRevision(),
      runtime: this.sources.runtime(),
      queueDepth: queue?.depth,
      deadLetters: (queue?.deadLetters ?? []).map((entry) => ({
        ...entry,
        errorSummary: redactDiagnostic(entry.errorSummary),
      })),
      dataDisk: diskResult.value,
      recentErrors,
    });
  }

  private async probe<T>(name: string, operation: () => Promise<T>) {
    const startedAt = performance.now();
    // A timeout cannot cancel every driver. Reuse an unsettled probe instead of accumulating I/O.
    let pending = this.probes.get(name) as Promise<T> | undefined;
    if (!pending) {
      pending = Promise.resolve()
        .then(operation)
        .finally(() => {
          this.probes.delete(name);
        });
      this.probes.set(name, pending);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("健康检查超时，请检查依赖连接。")),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return {
        ready: true as const,
        detail: "就绪",
        durationMs: Math.round(performance.now() - startedAt),
        value,
      };
    } catch (error) {
      return {
        ready: false as const,
        detail: redactDiagnostic(error instanceof Error ? error.message : "健康检查失败。"),
        durationMs: Math.round(performance.now() - startedAt),
        value: undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function redactDiagnostic(message: string): string {
  return message
    .replace(/(?:postgres(?:ql)?|redis|nats|https?):\/\/[^\s]+/gi, "[redacted-endpoint]")
    .replace(/(?:password|token|secret|credential)\s*[=:]\s*\S+/gi, "field=[redacted]")
    .slice(0, 500);
}
