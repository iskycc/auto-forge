import {
  type AttemptSchedulingContext,
  CoalescedOperation,
  type ExecutionControlRepository,
  type RunBatchSchedulingPort,
} from "@autoforge/application";

import type { WorkDispatcher } from "./work-runtime";

export { workDispatcher } from "./work-runtime";

/**
 * 高频 Runner 控制事务转交工作线程执行：Lite 模式避免同步 SQLite 阻塞 Web
 * 事件循环，卸载全部热点操作。Full 模式不使用此代理——r39 基准实测卸载后
 * 完成请求服务端 p50 虽由 42ms 降至 28ms，但执行阶段墙钟由客户端驱动并未
 * 改善，领取/批次创建因车道连接池争用回退，净收益为负；Full 执行仓储保持
 * 内联（见 services.ts），仅补位调度交给工作线程。
 */
export function workerBackedExecutionControlRepository(
  local: ExecutionControlRepository,
  dispatcher: WorkDispatcher | undefined,
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
        case "resolveAttemptSchedulingContext":
          return async (attemptId: string) => {
            const contexts = (await dispatcher.resolveAttemptSchedulingContexts([attemptId])) as
              Array<AttemptSchedulingContext & { attemptId: string }> | undefined;
            const context = contexts?.[0];
            if (!context) return null;
            return {
              batchId: context.batchId,
              executionRunId: context.executionRunId,
              runnerId: context.runnerId,
              attemptNumber: context.attemptNumber,
              displayName: context.displayName,
              ...(context.heldRound !== undefined ? { heldRound: context.heldRound } : {}),
            };
          };
        case "resolveAttemptSchedulingContexts":
          return (attemptIds: readonly string[]) =>
            dispatcher.resolveAttemptSchedulingContexts(attemptIds) as ReturnType<
              NonNullable<ExecutionControlRepository["resolveAttemptSchedulingContexts"]>
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
        default:
          break;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 合并同一批次/Runner 的高频补调度请求，避免并发完成上报制造重复扫描。 */
export class CoalescingSchedulingPort implements RunBatchSchedulingPort {
  private readonly inFlight = new Map<string, CoalescedOperation<unknown>>();
  private readonly pendingRunnerCapacity = new Map<string, number>();

  constructor(
    private readonly local: RunBatchSchedulingPort,
    private readonly dispatcher: WorkDispatcher | undefined,
  ) {}

  schedule(batchId: string): Promise<unknown> {
    return this.coalesce(`batch:${batchId}`, () =>
      this.dispatcher ? this.dispatcher.scheduleBatch(batchId) : this.local.schedule(batchId),
    );
  }

  scheduleForRunner(
    runnerId: string,
    batchLimit = 8,
    liveAvailableSlots?: number,
  ): Promise<unknown> {
    if (liveAvailableSlots !== undefined) {
      this.pendingRunnerCapacity.set(runnerId, liveAvailableSlots);
    }
    return this.coalesce(`runner:${runnerId}`, () => {
      const pendingLiveAvailableSlots = this.pendingRunnerCapacity.get(runnerId);
      this.pendingRunnerCapacity.delete(runnerId);
      return this.dispatcher
        ? this.dispatcher.scheduleForRunner(runnerId, batchLimit, pendingLiveAvailableSlots)
        : this.local.scheduleForRunner(runnerId, batchLimit, pendingLiveAvailableSlots);
    });
  }

  private coalesce(key: string, operation: () => Promise<unknown>): Promise<unknown> {
    const existing = this.inFlight.get(key);
    if (existing) return existing.requestAnotherPass();
    const pending = new CoalescedOperation(operation);
    this.inFlight.set(key, pending);
    void pending.result.then(
      () => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      },
      () => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      },
    );
    return pending.result;
  }
}
