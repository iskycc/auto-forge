/**
 * 自托管服务与 Next Route Handler 共享的进程内边界。此文件刻意不导入工作区包，
 * 使 NodeNext 编译的 server 入口不会直接执行尚未打包的 TypeScript workspace 源码。
 */
export interface WorkDispatcher {
  scheduleBatch(batchId: string): Promise<unknown>;
  scheduleForRunner(runnerId: string, batchLimit: number): Promise<number>;
  appendAttemptLogChunks(input: unknown): Promise<unknown>;
  claimAssignments(input: unknown): Promise<unknown>;
  renewLease(input: unknown): Promise<unknown>;
  completeAttempt(input: unknown): Promise<unknown>;
  declareArtifacts(input: unknown): Promise<unknown>;
  recoverExpired(input: unknown): Promise<unknown>;
  resolveAttemptSchedulingContexts(attemptIds: readonly string[]): Promise<unknown>;
  terminateBatch(input: unknown): Promise<number>;
  close(): Promise<void>;
}

const runtime = globalThis as typeof globalThis & {
  __autoforgeWorkDispatcher?: WorkDispatcher;
};

export function registerWorkDispatcher(dispatcher: WorkDispatcher): void {
  runtime.__autoforgeWorkDispatcher = dispatcher;
}

export function unregisterWorkDispatcher(dispatcher: WorkDispatcher): void {
  if (runtime.__autoforgeWorkDispatcher === dispatcher) {
    delete runtime.__autoforgeWorkDispatcher;
  }
}

export function workDispatcher(): WorkDispatcher | undefined {
  return runtime.__autoforgeWorkDispatcher;
}
