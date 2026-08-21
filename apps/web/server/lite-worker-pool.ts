import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

import type { LiteWorkDispatcher } from "../src/lib/lite-work-runtime.ts";
import { liteWorkerLaneCount } from "../src/lib/lite-worker-sizing.ts";
import type {
  LiteWorkerConfiguration,
  LiteWorkerRequest,
  LiteWorkerResponse,
  LiteWorkerTask,
} from "./lite-work-protocol.ts";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

export class LiteWorkerPool implements LiteWorkDispatcher {
  private readonly schedulingLanes: WorkerLane[];
  private readonly logLanes: WorkerLane[];
  private schedulingCursor = 0;

  constructor(
    configuration: LiteWorkerConfiguration,
    backgroundConcurrency: number,
    shutdownGraceMs: number,
  ) {
    const laneCount = liteWorkerLaneCount(availableParallelism(), backgroundConcurrency);
    this.schedulingLanes = Array.from(
      { length: laneCount },
      () => new WorkerLane(configuration, shutdownGraceMs),
    );
    this.logLanes = Array.from(
      { length: laneCount },
      () => new WorkerLane(configuration, shutdownGraceMs),
    );
  }

  async scheduleBatch(batchId: string): Promise<unknown> {
    return this.keyedControlLane(`batch:${batchId}`).dispatch({
      kind: "schedule-batch",
      batchId,
    });
  }

  async scheduleForRunner(runnerId: string, batchLimit: number): Promise<number> {
    return (await this.keyedControlLane(`runner:${runnerId}`).dispatch({
      kind: "schedule-runner",
      runnerId,
      batchLimit,
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

  async terminateBatch(input: unknown): Promise<number> {
    const batchId = stringProperty(input, "batchId");
    return (await this.keyedControlLane(`batch:${batchId}`).dispatch({
      kind: "terminate-batch",
      batchId,
      input,
    })) as number;
  }

  async close(): Promise<void> {
    await Promise.all([...this.schedulingLanes, ...this.logLanes].map((lane) => lane.close()));
  }

  private nextSchedulingLane(): WorkerLane {
    const lane = this.schedulingLanes[this.schedulingCursor % this.schedulingLanes.length]!;
    this.schedulingCursor += 1;
    return lane;
  }

  private keyedControlLane(key: string): WorkerLane {
    return this.schedulingLanes[stableLaneIndex(key, this.schedulingLanes.length)]!;
  }
}

class WorkerLane {
  private worker: Worker | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly drainWaiters = new Set<() => void>();
  private closing = false;

  constructor(
    private readonly configuration: LiteWorkerConfiguration,
    private readonly shutdownGraceMs: number,
  ) {}

  dispatch(task: LiteWorkerTask): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Lite worker pool is closing."));
    const worker = this.ensureWorker();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, task } satisfies LiteWorkerRequest);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (!this.worker) return;
    await this.waitForDrain();
    if (this.pending.size > 0) {
      this.fail(new Error("Lite worker did not drain before the shutdown deadline."));
    }
    await this.worker.terminate();
    this.worker = undefined;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerModuleUrl(), { workerData: this.configuration });
    worker.on("message", (response: LiteWorkerResponse) => this.receive(response));
    worker.on("error", (error) => this.fail(error));
    worker.on("exit", (code) => {
      if (code !== 0 && !this.closing) {
        this.fail(new Error(`Lite worker stopped unexpectedly with exit code ${code}.`));
      }
      if (this.worker === worker) this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private receive(response: LiteWorkerResponse): void {
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    if (response.ok) request.resolve(response.value);
    else request.reject(workerError(response.error));
    this.notifyDrained();
  }

  private fail(error: unknown): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
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
    import.meta.url.endsWith(".ts")
      ? "../dist-server/server/lite-work-thread.js"
      : "./lite-work-thread.js",
    import.meta.url,
  );
}

function stableLaneIndex(value: string, laneCount: number): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % laneCount;
}

function stringProperty(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "unknown";
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : "unknown";
}

function workerError(input: {
  name: string;
  message: string;
  code?: string;
  details?: unknown;
  stack?: string;
}): Error {
  const error = new Error(input.message);
  error.name = input.name;
  if (input.code) Object.assign(error, { code: input.code, details: input.details });
  if (input.stack) error.stack = input.stack;
  return error;
}
