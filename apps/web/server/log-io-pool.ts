import { Worker } from "node:worker_threads";
import type { LogIoDispatcher, LogIoMethod } from "../src/lib/log-io-runtime.ts";
import { logPayloadBytes, MAX_QUEUED_LOG_BYTES } from "../src/lib/log-io-runtime.ts";
import { stableLaneIndex } from "../src/lib/worker-sizing.ts";

export type LogIoRequest = { id: number; method: LogIoMethod; args: unknown[] };
export type LogIoResponse = { id: number } & (
  { ok: true; value: unknown } | { ok: false; error: { message: string; code?: string } }
);

type PendingLogOperation = {
  request: LogIoRequest;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
  bytes: number;
};

/** Separate queues keep disk scans away from HTTP, uploads and each other. */
export class LogIoPool implements LogIoDispatcher {
  private readonly reads: LogIoLane[];
  private readonly writes: LogIoLane[];
  private readonly maintenance: LogIoLane;

  constructor(
    directory: string,
    reportError: (error: Error) => void,
    workerUrl = new URL(
      import.meta.url.endsWith(".ts")
        ? "../dist-server/server/attempt-log-thread.js"
        : "./attempt-log-thread.js",
      import.meta.url,
    ),
    resources = { readLanes: 1, writeLanes: 1, heapMb: 128 },
  ) {
    let reportedAt = -Infinity;
    const reportBounded = (error: Error) => {
      if (Date.now() - reportedAt < 60_000) return;
      reportedAt = Date.now();
      reportError(error);
    };
    this.reads = Array.from(
      { length: resources.readLanes },
      () => new LogIoLane(directory, workerUrl, 16, 5_000, true, reportBounded, resources.heapMb),
    );
    this.writes = Array.from(
      { length: Math.max(1, resources.writeLanes) },
      () => new LogIoLane(directory, workerUrl, 64, 15_000, false, reportBounded, resources.heapMb),
    );
    this.maintenance = new LogIoLane(
      directory,
      workerUrl,
      4,
      5_000,
      false,
      reportBounded,
      resources.heapMb,
    );
  }

  call(method: LogIoMethod, args: unknown[]): Promise<unknown> {
    const lane =
      method === "appendChunks" || method === "recordWatermarks"
        ? this.writes[stableLaneIndex(attemptKey(args[0]), this.writes.length)]!
        : method === "listChunks" || method === "acknowledgedSequence"
          ? this.reads.reduce((least, candidate) =>
              candidate.pendingCount < least.pendingCount ? candidate : least,
            )
          : this.maintenance;
    return lane.call(method, args);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.reads, ...this.writes, this.maintenance].map((lane) => lane.close()),
    );
  }
}

class LogIoLane {
  private worker: Worker | undefined;
  private active: PendingLogOperation | undefined;
  private readonly queued: PendingLogOperation[] = [];
  private nextId = 0;
  private stopped = false;
  private pendingBytes = 0;
  private terminating: Promise<void> | undefined;

  constructor(
    private readonly directory: string,
    private readonly workerUrl: URL,
    private readonly capacity: number,
    private readonly deadlineMs: number,
    private readonly interruptible: boolean,
    private readonly reportError: (error: Error) => void,
    private readonly heapMb: number,
  ) {}

  get pendingCount(): number {
    return this.queued.length + Number(!!this.active);
  }

  call(method: LogIoMethod, args: unknown[]): Promise<unknown> {
    if (this.stopped)
      return Promise.reject(
        logIoError("PLATFORM_LOG_UNAVAILABLE", "日志服务正在关闭，请稍后重试。"),
      );
    const bytes = logPayloadBytes(args[0]);
    if (
      this.queued.length + Number(!!this.active) >= this.capacity ||
      this.pendingBytes + bytes > MAX_QUEUED_LOG_BYTES
    ) {
      const error = logIoError("PLATFORM_LOG_BUSY", "日志服务繁忙，请稍后重试。");
      this.reportError(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const pending: PendingLogOperation = {
        request: { id: ++this.nextId, method, args },
        resolve,
        reject,
        timeout: setTimeout(() => this.expire(pending), this.deadlineMs),
        bytes,
      };
      this.pendingBytes += bytes;
      this.queued.push(pending);
      this.startNext();
    });
  }

  private startNext(): void {
    if (this.active || this.stopped || this.terminating) return;
    const pending = this.queued.shift();
    if (!pending) return;
    this.active = pending;
    try {
      const worker = (this.worker ??= this.startWorker());
      worker.postMessage(pending.request);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("日志线程启动失败。", { cause: error }));
    }
  }

  private startWorker(): Worker {
    const worker = new Worker(this.workerUrl, {
      workerData: { directory: this.directory },
      resourceLimits: { maxOldGenerationSizeMb: this.heapMb },
    });
    worker.on("message", (response: LogIoResponse) => {
      if (worker !== this.worker || response.id !== this.active?.request.id) return;
      const pending = this.active;
      this.active = undefined;
      this.pendingBytes -= pending.bytes;
      clearTimeout(pending.timeout);
      if (response.ok) pending.resolve(response.value);
      else {
        const error = logIoError(
          response.error.code ?? "PLATFORM_LOG_UNAVAILABLE",
          response.error.message,
        );
        pending.reject(error);
        if (error.code.startsWith("PLATFORM_LOG_")) this.reportError(error);
      }
      this.startNext();
    });
    worker.on("error", (error) => {
      if (worker === this.worker) this.fail(error);
    });
    worker.on("exit", (code) => {
      if (worker === this.worker) this.fail(new Error(`日志线程意外退出 (${code})。`));
    });
    return worker;
  }

  private expire(pending: PendingLogOperation): void {
    const error = logIoError(
      "PLATFORM_LOG_TIMEOUT",
      "日志操作超时，请稍后重试；搜索时可缩小时间范围。",
    );
    pending.reject(error);
    this.reportError(error);
    if (this.active === pending) {
      // A timed-out write may still commit. Keep its slot until completion and let
      // the Runner retry idempotently; never kill a writer as a read cancellation.
      if (this.interruptible) this.fail(error);
    } else {
      const index = this.queued.indexOf(pending);
      if (index >= 0) {
        this.queued.splice(index, 1);
        this.pendingBytes -= pending.bytes;
      }
    }
  }

  private fail(cause: Error): void {
    const error = logIoError("PLATFORM_LOG_UNAVAILABLE", "日志服务暂不可用，请稍后重试。", cause);
    this.reportError(error);
    this.rejectPending(error);
    const worker = this.worker;
    this.worker = undefined;
    if (worker)
      this.terminating = worker
        .terminate()
        .then(() => undefined, this.reportError)
        .finally(() => {
          this.terminating = undefined;
          this.startNext();
        });
  }

  private rejectPending(error: Error): void {
    for (const pending of [...(this.active ? [this.active] : []), ...this.queued.splice(0)]) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.active = undefined;
    this.pendingBytes = 0;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.rejectPending(logIoError("PLATFORM_LOG_UNAVAILABLE", "日志服务正在关闭。"));
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
    await this.terminating;
  }
}

function attemptKey(input: unknown): string {
  return input &&
    typeof input === "object" &&
    "attemptId" in input &&
    typeof input.attemptId === "string"
    ? input.attemptId
    : "unknown";
}

function logIoError(code: string, message: string, cause?: Error): Error & { code: string } {
  return Object.assign(new Error(message, { cause }), { code });
}
