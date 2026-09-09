import {
  isRuntimeDatabaseContention,
  type RuntimeDiagnosticContext,
} from "@autoforge/contracts/runtime-diagnostics";
import { runtimePriority } from "../src/lib/runtime-priority.ts";
import { detectRuntimeResources } from "@autoforge/platform-config/runtime-resources";
import { Worker } from "node:worker_threads";

import type { WorkDispatcher } from "../src/lib/work-runtime.ts";
import { logPayloadBytes, MAX_QUEUED_LOG_BYTES } from "../src/lib/log-io-runtime.ts";
import {
  fullWorkerPoolMaxPerLane,
  webResourcePlan,
  stableLaneIndex,
  type WebResourcePlan,
} from "../src/lib/worker-sizing.ts";
import type {
  WorkRequest,
  WorkResponse,
  WorkTask,
  WorkThreadConfiguration,
} from "./work-protocol.ts";

type PendingRequest = {
  bytes: number;
  finishForeground(): void;
  detachAbort(): void;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

/** Shared by the embedded Lite worker and the standalone Full worker. */
export class BackgroundWorkerPool {
  private readonly lanes: WorkerLane[];

  constructor(
    configuration: WorkThreadConfiguration,
    options: { lanes: number; heapMb: number; shutdownGraceMs: number },
  ) {
    this.lanes = Array.from(
      { length: options.lanes },
      (_, index) =>
        new WorkerLane(
          {
            ...configurationForLane(configuration, options.lanes, index),
            prioritySignal: runtimePriority().signal,
            ...(configuration.full ? { full: { ...configuration.full, databasePoolMax: 1 } } : {}),
          },
          options.shutdownGraceMs,
          options.heapMb,
        ),
    );
  }

  executeBackgroundJob(job: unknown, signal: AbortSignal): Promise<unknown> {
    return this.nextLane().dispatch({ kind: "background-job", job }, signal);
  }

  runPlatformMaintenance(
    operation: "notifications" | "retention" | "orphan-logs",
  ): Promise<unknown> {
    return this.nextLane().dispatch({ kind: "platform-maintenance", operation });
  }

  async close(): Promise<void> {
    await Promise.all(this.lanes.map((lane) => lane.close()));
  }

  private nextLane(): WorkerLane {
    return this.lanes.reduce((least, lane) =>
      lane.pendingCount < least.pendingCount ? lane : least,
    );
  }
}

export class WorkerPool implements WorkDispatcher {
  private readonly schedulingLanes: WorkerLane[];
  private readonly controlLanes: WorkerLane[];
  private readonly maintenanceLanes: WorkerLane[];
  private readonly logLanes: WorkerLane[];
  private schedulingCursor = 0;

  get backgroundConcurrency(): number {
    return this.maintenanceLanes.length;
  }

  constructor(
    configuration: WorkThreadConfiguration,
    backgroundConcurrency: number,
    shutdownGraceMs: number,
    readonly resourcePlan: WebResourcePlan = webResourcePlan(
      detectRuntimeResources(),
      configuration.mode,
      configuration.full?.databasePoolMax,
    ),
  ) {
    const laneCount = resourcePlan.schedulingLanes;
    const laneConfiguration = configurationForLane(configuration, laneCount);
    this.schedulingLanes = Array.from(
      { length: laneCount },
      (_, index) =>
        new WorkerLane(
          configurationForLane(configuration, laneCount, index),
          shutdownGraceMs,
          resourcePlan.workerHeapMb,
        ),
    );
    this.maintenanceLanes = Array.from(
      { length: Math.min(backgroundConcurrency, resourcePlan.maintenanceLanes) },
      () =>
        new WorkerLane(
          {
            ...laneConfiguration,
            prioritySignal: runtimePriority().signal,
            ...(configuration.full ? { full: { ...configuration.full, databasePoolMax: 1 } } : {}),
          },
          shutdownGraceMs,
          resourcePlan.workerHeapMb,
        ),
    );
    this.controlLanes =
      configuration.mode === "full"
        ? this.schedulingLanes
        : Array.from(
            { length: resourcePlan.controlLanes },
            () => new WorkerLane(laneConfiguration, shutdownGraceMs, resourcePlan.workerHeapMb),
          );
    // Full 的执行仓储保持在 Web 主线程，只有补位调度进入工作线程，不创建永远
    // 不会使用的独立日志车道和连接池。Lite 仍将同步日志 SQLite I/O 隔离开。
    this.logLanes =
      configuration.mode === "full"
        ? this.schedulingLanes
        : Array.from(
            { length: resourcePlan.uploadLanes },
            () => new WorkerLane(laneConfiguration, shutdownGraceMs, resourcePlan.workerHeapMb),
          );
  }

  async runPlatformMaintenance(operation: "notifications" | "retention"): Promise<boolean> {
    const lane = this.maintenanceLanes.reduce((least, candidate) =>
      candidate.pendingCount < least.pendingCount ? candidate : least,
    );
    return (await lane.dispatch({
      kind: "platform-maintenance",
      operation,
    })) as boolean;
  }

  async executeBackgroundJob(job: unknown, signal: AbortSignal): Promise<void> {
    const lane = this.maintenanceLanes.reduce((least, candidate) =>
      candidate.pendingCount < least.pendingCount ? candidate : least,
    );
    await lane.dispatch({ kind: "background-job", job }, signal);
  }

  parseFile(
    operation: "inspect-jar" | "read-jar-source" | "parse-ddt",
    input: unknown,
  ): Promise<unknown> {
    const lane = this.maintenanceLanes.reduce((least, candidate) =>
      candidate.pendingCount < least.pendingCount ? candidate : least,
    );
    // Parsing a user upload has no persistent side effects. Bound admission before copying bytes.
    if (lane.pendingCount >= 2)
      return Promise.reject(
        Object.assign(new Error("文件解析繁忙，请稍后重试。"), {
          name: "DomainError",
          code: "PLATFORM_BUSY",
        }),
      );
    return lane.dispatch({ kind: "parse-file", operation, input });
  }

  async scheduleBatch(batchId: string): Promise<unknown> {
    return this.keyedSchedulingLane(`batch:${batchId}`).dispatch({
      kind: "schedule-batch",
      batchId,
    });
  }

  async triggerDueSchedules(): Promise<number> {
    return (await this.nextSchedulingLane().dispatch({ kind: "trigger-schedules" })) as number;
  }

  createBatch(input: unknown): Promise<unknown> {
    return this.nextSchedulingLane().dispatch({ kind: "create-batch", input });
  }

  createSingleDdtCase(input: unknown): Promise<unknown> {
    return this.nextSchedulingLane().dispatch({ kind: "create-single-ddt-case", input });
  }

  async scheduleForRunner(
    runnerId: string,
    batchLimit: number,
    liveAvailableSlots?: number,
  ): Promise<number> {
    return (await this.keyedSchedulingLane(`runner:${runnerId}`).dispatch({
      kind: "schedule-runner",
      runnerId,
      batchLimit,
      ...(liveAvailableSlots === undefined ? {} : { liveAvailableSlots }),
    })) as number;
  }

  appendAttemptLogChunks(input: unknown): Promise<unknown> {
    const attemptId = stringProperty(input, "attemptId");
    const lane = this.logLanes[stableLaneIndex(attemptId, this.logLanes.length)]!;
    return lane.dispatch({ kind: "append-attempt-log-chunks", attemptId, input });
  }

  claimAssignments(input: unknown): Promise<unknown> {
    const runnerId = stringProperty(input, "runnerId");
    return this.keyedControlLane(`runner:${runnerId}`).dispatch({
      kind: "claim-assignments",
      runnerId,
      input,
    });
  }

  reconcileAttempts(input: unknown): Promise<unknown> {
    return this.keyedControlLane(`runner:${stringProperty(input, "runnerId")}`).dispatch({
      kind: "reconcile-attempts",
      input,
    });
  }

  renewLease(input: unknown): Promise<unknown> {
    const leaseId = stringProperty(input, "leaseId");
    return this.keyedControlLane(`lease:${leaseId}`).dispatch({
      kind: "renew-lease",
      leaseId,
      input,
    });
  }

  completeAttempt(input: unknown): Promise<unknown> {
    const attemptId = stringProperty(input, "attemptId");
    return this.keyedControlLane(`attempt:${attemptId}`).dispatch({
      kind: "complete-attempt",
      attemptId,
      input,
    });
  }

  declareArtifacts(input: unknown): Promise<unknown> {
    const attemptId = stringProperty(input, "attemptId");
    return this.keyedControlLane(`attempt:${attemptId}`).dispatch({
      kind: "declare-artifacts",
      attemptId,
      input,
    });
  }

  recoverExpired(input: unknown): Promise<unknown> {
    return this.nextSchedulingLane().dispatch({ kind: "recover-expired", input });
  }

  resolveAttemptSchedulingContexts(attemptIds: readonly string[]): Promise<unknown> {
    if (attemptIds.length === 0) return Promise.resolve([]);
    return this.keyedControlLane(`attempt:${attemptIds[0]}`).dispatch({
      kind: "resolve-attempt-contexts",
      attemptIds: [...attemptIds],
    });
  }

  async terminateBatch(input: unknown): Promise<number> {
    const batchId = stringProperty(input, "batchId");
    return (await this.keyedControlLane(`batch:${batchId}`).dispatch({
      kind: "terminate-batch",
      batchId,
      input,
    })) as number;
  }

  /**
   * 启动预热所有车道：工作线程按需构建数据库句柄、执行迁移校验并预热连接池，
   * 不预热时这些冷启动成本会落在首个真实任务（通常是 Runner 心跳触发的补位
   * 调度）上。失败无害——首个真实任务会退回按需冷启动，错误在那时照常暴露。
   */
  async warmup(): Promise<void> {
    await Promise.allSettled(this.uniqueLanes().map((lane) => lane.dispatch({ kind: "warmup" })));
  }

  async close(): Promise<void> {
    await Promise.all(this.uniqueLanes().map((lane) => lane.close()));
  }

  private uniqueLanes(): WorkerLane[] {
    return [
      ...new Set([
        ...this.schedulingLanes,
        ...this.logLanes,
        ...this.controlLanes,
        ...this.maintenanceLanes,
      ]),
    ];
  }

  private nextSchedulingLane(): WorkerLane {
    const lane = this.schedulingLanes[this.schedulingCursor % this.schedulingLanes.length]!;
    this.schedulingCursor += 1;
    return lane;
  }

  private keyedControlLane(key: string): WorkerLane {
    return this.controlLanes[stableLaneIndex(key, this.controlLanes.length)]!;
  }

  private keyedSchedulingLane(key: string): WorkerLane {
    return this.schedulingLanes[stableLaneIndex(key, this.schedulingLanes.length)]!;
  }
}

function configurationForLane(
  configuration: WorkThreadConfiguration,
  laneCount: number,
  laneIndex = 0,
): WorkThreadConfiguration {
  if (configuration.mode !== "full" || !configuration.full) return configuration;
  return {
    ...configuration,
    full: {
      ...configuration.full,
      databasePoolMax: fullWorkerPoolMaxPerLane(
        configuration.full.databasePoolMax,
        laneCount,
        laneIndex,
      ),
    },
  };
}

class WorkerLane {
  private worker: Worker | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly drainWaiters = new Set<() => void>();
  private closing = false;
  private workerFailed = false;
  private pendingBytes = 0;

  constructor(
    private readonly configuration: WorkThreadConfiguration,
    private readonly shutdownGraceMs: number,
    private readonly heapMb: number,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  dispatch(task: WorkTask, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closing) return Promise.reject(new Error("Work thread pool is closing."));
    if (this.workerFailed)
      return Promise.reject(new Error("Work thread is recovering; retry after it exits."));
    const bytes = task.kind === "append-attempt-log-chunks" ? logPayloadBytes(task.input) : 0;
    if (
      this.pending.size >= (task.kind === "append-attempt-log-chunks" ? 64 : 256) ||
      this.pendingBytes + bytes > MAX_QUEUED_LOG_BYTES
    ) {
      runtimePriority().report(
        task.kind === "append-attempt-log-chunks" ? "log_io" : "execution_control",
      );
      return Promise.reject(
        Object.assign(new Error("执行控制队列繁忙，请稍后重试。"), {
          name: "DomainError",
          code: "PLATFORM_BUSY",
        }),
      );
    }
    const worker = this.ensureWorker();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const abort = () => worker.postMessage({ id, cancel: true });
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        bytes,
        resolve,
        reject,
        finishForeground:
          task.kind === "platform-maintenance" ||
          task.kind === "background-job" ||
          task.kind === "parse-file"
            ? () => undefined
            : runtimePriority().beginForeground(),
        detachAbort: () => signal?.removeEventListener("abort", abort),
      });
      this.pendingBytes += bytes;
      try {
        worker.postMessage({ id, task } satisfies WorkRequest);
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const worker = this.worker;
    if (!worker) return;
    await this.waitForDrain();
    if (this.pending.size > 0) {
      this.fail(new Error("Work thread did not drain before the shutdown deadline."));
    }
    await worker.terminate();
    if (this.worker === worker) this.worker = undefined;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerModuleUrl(), {
      workerData: this.configuration,
      resourceLimits: { maxOldGenerationSizeMb: this.heapMb },
    });
    worker.on("message", (response: WorkResponse) => {
      if (this.worker === worker && !this.workerFailed) this.receive(response);
    });
    worker.on("error", (error) => {
      if (this.worker !== worker) return;
      this.workerFailed = true;
      this.fail(error);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.workerFailed = false;
      if (!this.closing && (code !== 0 || this.pending.size > 0)) {
        this.fail(new Error(`Work thread stopped unexpectedly with exit code ${code}.`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private receive(response: WorkResponse): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    this.pendingBytes -= request.bytes;
    request.finishForeground();
    request.detachAbort();
    if (response.ok) request.resolve(response.value);
    else {
      const context = response.error.runtimeContext;
      if (context && isRuntimeDatabaseContention(context))
        runtimePriority().report("database_busy", context);
      request.reject(workerError(response.error));
    }
    this.notifyDrained();
  }

  private fail(error: unknown): void {
    if (!this.closing)
      runtimePriority().report(
        this.configuration.prioritySignal ? "background_refresh" : "execution_control",
      );
    for (const request of this.pending.values()) {
      request.finishForeground();
      request.detachAbort();
      request.reject(error);
    }
    this.pending.clear();
    this.pendingBytes = 0;
    this.notifyDrained();
  }

  private async waitForDrain(): Promise<void> {
    if (this.pending.size === 0) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.drainWaiters.delete(done);
        resolve();
      }, this.shutdownGraceMs);
      const done = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.drainWaiters.add(done);
    });
  }

  private notifyDrained(): void {
    if (this.pending.size > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

function workerModuleUrl(): URL {
  return new URL(
    import.meta.url.endsWith(".ts") ? "../dist-server/server/work-thread.js" : "./work-thread.js",
    import.meta.url,
  );
}

function stringProperty(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "unknown";
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : "unknown";
}

function workerError(input: {
  runtimeContext?: RuntimeDiagnosticContext;
  name: string;
  message: string;
  code?: string;
  details?: unknown;
  stack?: string;
}): Error {
  const error = new Error(input.message);
  if (input.runtimeContext) Object.assign(error, { runtimeContext: input.runtimeContext });
  error.name = input.name;
  if (input.code) Object.assign(error, { code: input.code, details: input.details });
  if (
    input.code === "DDT_DUPLICATE_COLUMNS" &&
    input.details &&
    typeof input.details === "object"
  ) {
    Object.assign(error, {
      fileName: Reflect.get(input.details, "fileName"),
      conflicts: Reflect.get(input.details, "conflicts"),
    });
  }
  if (input.stack) error.stack = input.stack;
  return error;
}
