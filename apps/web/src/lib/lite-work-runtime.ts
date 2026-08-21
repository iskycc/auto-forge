/**
 * 自托管服务与 Next Route Handler 共享的进程内边界。此文件刻意不导入工作区包，
 * 使 NodeNext 编译的 server 入口不会直接执行尚未打包的 TypeScript workspace 源码。
 */
export interface LiteWorkDispatcher {
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
  __autoforgeLiteWorkDispatcher?: LiteWorkDispatcher;
};

export function registerLiteWorkDispatcher(dispatcher: LiteWorkDispatcher): void {
  runtime.__autoforgeLiteWorkDispatcher = dispatcher;
}

export function unregisterLiteWorkDispatcher(dispatcher: LiteWorkDispatcher): void {
  if (runtime.__autoforgeLiteWorkDispatcher === dispatcher) {
    delete runtime.__autoforgeLiteWorkDispatcher;
  }
}

export function liteWorkDispatcher(): LiteWorkDispatcher | undefined {
  return runtime.__autoforgeLiteWorkDispatcher;
}
