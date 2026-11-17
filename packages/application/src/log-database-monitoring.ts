import type { LogDatabaseStatus, PostgresStorageCapacity } from "@autoforge/contracts";
import { DomainError, isDomainError } from "@autoforge/domain";
import type { Clock } from "./ports";

const SNAPSHOT_LIFETIME_MS = 90_000;
const MAXIMUM_CACHED_SERVERS = 256;
const MAXIMUM_PENDING_PROBES = 4;

export type LogDatabaseMonitoringTargets = { items: Array<{ id: string }>; nextCursor?: string };

type MonitoringPorts = {
  list(cursor?: string): Promise<LogDatabaseMonitoringTargets>;
  check(id: string): Promise<void>;
  capacity(id: string): Promise<PostgresStorageCapacity>;
};

/** Observational snapshots never choose a write destination or change log ownership. */
export class LogDatabaseMonitoringService {
  private readonly snapshots = new Map<string, LogDatabaseStatus>();
  private readonly pending = new Map<string, Promise<LogDatabaseStatus>>();
  private epoch = 0;

  constructor(
    private readonly ports: MonitoringPorts,
    private readonly clock: Clock,
  ) {}

  read(id: string, refresh = false): Promise<LogDatabaseStatus> {
    const previous = this.snapshots.get(id);
    if (
      !refresh &&
      previous &&
      this.clock.now().getTime() - Date.parse(previous.heartbeat.checkedAt) < SNAPSHOT_LIFETIME_MS
    )
      return Promise.resolve(previous);
    const epoch = this.epoch;
    const key = `${epoch}:${id}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= MAXIMUM_PENDING_PROBES)
      throw new DomainError("PLATFORM_LOG_BUSY", "日志库心跳检查繁忙，请稍后重试。");
    const request = this.sample(id, previous)
      .then((status) => {
        if (epoch === this.epoch) {
          if (!this.snapshots.has(id) && this.snapshots.size >= MAXIMUM_CACHED_SERVERS)
            this.snapshots.delete(this.snapshots.keys().next().value!);
          this.snapshots.set(id, status);
        }
        return status;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  invalidate(): void {
    this.epoch++;
    this.snapshots.clear();
  }

  async refreshAll(signal: AbortSignal, canContinue: () => boolean): Promise<void> {
    let cursor: string | undefined;
    while (!signal.aborted && canContinue()) {
      const page = await this.ports.list(cursor);
      for (let index = 0; index < page.items.length; index += 2) {
        if (signal.aborted || !canContinue()) return;
        const results = await Promise.allSettled(
          page.items.slice(index, index + 2).map(async ({ id }) => this.read(id, true)),
        );
        for (const result of results) {
          if (result.status === "fulfilled") continue;
          if (isDomainError(result.reason) && result.reason.code === "PLATFORM_LOG_BUSY") return;
          // A server removed between listing and sampling is no longer a monitoring target.
          if (isDomainError(result.reason) && result.reason.code === "LOG_DATABASE_NOT_FOUND")
            continue;
          throw result.reason;
        }
      }
      if (!page.nextCursor) return;
      if (page.nextCursor === cursor)
        throw new Error("Log database monitoring received a non-advancing registry cursor.");
      cursor = page.nextCursor;
    }
  }

  private async sample(
    id: string,
    previous: LogDatabaseStatus | undefined,
  ): Promise<LogDatabaseStatus> {
    const results = await Promise.allSettled([
      this.heartbeat(id, previous),
      this.capacity(id, previous?.capacity),
    ]);
    // Admission stays occupied until both I/O operations finish, even if one fails early.
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const [heartbeat, capacity] = results;
    if (heartbeat.status !== "fulfilled" || capacity.status !== "fulfilled")
      throw new Error("Log database monitoring did not finish both probes.");
    return { heartbeat: heartbeat.value, capacity: capacity.value };
  }

  private async heartbeat(
    id: string,
    previous: LogDatabaseStatus | undefined,
  ): Promise<LogDatabaseStatus["heartbeat"]> {
    const startedAt = this.clock.now();
    try {
      await this.ports.check(id);
      const finishedAt = this.clock.now();
      return {
        status: "healthy",
        checkedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        lastSucceededAt: finishedAt.toISOString(),
        detail: "日志库连接与身份检查通过。",
      };
    } catch (cause) {
      if (
        isDomainError(cause) &&
        ["LOG_DATABASE_NOT_FOUND", "PLATFORM_LOG_BUSY"].includes(cause.code)
      )
        throw cause;
      const finishedAt = this.clock.now();
      return {
        status: "unavailable",
        checkedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        ...(previous?.heartbeat.lastSucceededAt
          ? { lastSucceededAt: previous.heartbeat.lastSucceededAt }
          : {}),
        errorCode: isDomainError(cause) ? cause.code : "PLATFORM_LOG_DATABASE_UNAVAILABLE",
        detail: "日志库连接或身份检查未通过，请检查连接配置、账号权限与服务状态。",
      };
    }
  }

  private async capacity(
    id: string,
    previous: PostgresStorageCapacity | undefined,
  ): Promise<PostgresStorageCapacity> {
    try {
      const value = await this.ports.capacity(id);
      if (
        value.status === "unavailable" &&
        previous?.capacityBytes !== undefined &&
        previous.availableBytes !== undefined
      )
        return { ...previous, ...value, status: "stale" };
      return value;
    } catch (cause) {
      if (
        isDomainError(cause) &&
        ["LOG_DATABASE_NOT_FOUND", "PLATFORM_LOG_BUSY"].includes(cause.code)
      )
        throw cause;
      const measured =
        previous?.availableBytes !== undefined && previous.capacityBytes !== undefined;
      return measured
        ? {
            ...previous,
            status: "stale",
            detail: "本次磁盘采样失败；当前仅保留上次采样值，请检查 Node Exporter。",
          }
        : {
            status: "unavailable",
            detail: "磁盘采样暂不可用，请检查 Node Exporter 配置与服务状态。",
          };
    }
  }
}
