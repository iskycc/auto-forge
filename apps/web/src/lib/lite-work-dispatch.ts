import type { ExecutionControlRepository, RunBatchSchedulingPort } from "@autoforge/application";

import type { LiteWorkDispatcher } from "./lite-work-runtime";

export { liteWorkDispatcher } from "./lite-work-runtime";

/** 高频 Runner 控制事务在 Lite 模式转交 worker thread，避免同步 SQLite 阻塞 Web。 */
export function workerBackedExecutionControlRepository(
  local: ExecutionControlRepository,
  dispatcher: LiteWorkDispatcher | undefined,
): ExecutionControlRepository {
  if (!dispatcher) return local;
  return new Proxy(local, {
    get(target, property) {
      switch (property) {
        case "claim":
          return (input: Parameters<ExecutionControlRepository["claim"]>[0]) =>
            dispatcher.claimAssignments(input) as ReturnType<ExecutionControlRepository["claim"]>;
        case "renewLease":
          return (input: Parameters<ExecutionControlRepository["renewLease"]>[0]) =>
            dispatcher.renewLease(input) as ReturnType<ExecutionControlRepository["renewLease"]>;
        case "completeAttempt":
          return (input: Parameters<ExecutionControlRepository["completeAttempt"]>[0]) =>
            dispatcher.completeAttempt(input) as ReturnType<
              ExecutionControlRepository["completeAttempt"]
            >;
        case "declareArtifacts":
          return (input: Parameters<ExecutionControlRepository["declareArtifacts"]>[0]) =>
            dispatcher.declareArtifacts(input) as ReturnType<
              ExecutionControlRepository["declareArtifacts"]
            >;
        case "recoverExpired":
          return (input: Parameters<ExecutionControlRepository["recoverExpired"]>[0]) =>
            dispatcher.recoverExpired(input) as ReturnType<
              ExecutionControlRepository["recoverExpired"]
            >;
        case "appendLogChunks":
          return (input: Parameters<ExecutionControlRepository["appendLogChunks"]>[0]) =>
            dispatcher.appendAttemptLogChunks(input) as ReturnType<
              ExecutionControlRepository["appendLogChunks"]
            >;
        case "terminateBatch":
          return (input: Parameters<ExecutionControlRepository["terminateBatch"]>[0]) =>
            dispatcher.terminateBatch(input) as ReturnType<
              ExecutionControlRepository["terminateBatch"]
            >;
        default: {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}

/** 合并同一批次/Runner 的高频补调度请求，避免并发完成上报制造重复扫描。 */
export class CoalescingSchedulingPort implements RunBatchSchedulingPort {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly local: RunBatchSchedulingPort,
    private readonly dispatcher: LiteWorkDispatcher | undefined,
  ) {}

  schedule(batchId: string): Promise<unknown> {
    return this.coalesce(`batch:${batchId}`, () =>
      this.dispatcher ? this.dispatcher.scheduleBatch(batchId) : this.local.schedule(batchId),
    );
  }

  scheduleForRunner(runnerId: string, batchLimit = 8): Promise<unknown> {
    return this.coalesce(`runner:${runnerId}`, () =>
      this.dispatcher
        ? this.dispatcher.scheduleForRunner(runnerId, batchLimit)
        : this.local.scheduleForRunner(runnerId, batchLimit),
    );
  }

  private coalesce(key: string, operation: () => Promise<unknown>): Promise<unknown> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = operation().finally(() => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }
}
