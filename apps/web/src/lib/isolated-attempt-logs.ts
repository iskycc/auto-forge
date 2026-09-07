import { relativeAttemptLogStorePath, type AsyncAttemptLogStore } from "@autoforge/db/sqlite";
import { DomainError } from "@autoforge/domain";
import { logIoDispatcher, type LogIoMethod, type LogIoDispatcher } from "./log-io-runtime";

/** Only pure path construction remains in Web; even stat/close must not touch log disks here. */
export function isolatedAttemptLogs(
  directory: string,
  providedDispatcher?: LogIoDispatcher,
): AsyncAttemptLogStore {
  async function call<Method extends LogIoMethod>(
    method: Method,
    args: Parameters<AsyncAttemptLogStore[Method]>,
  ): Promise<Awaited<ReturnType<AsyncAttemptLogStore[Method]>>> {
    const dispatcher = providedDispatcher ?? logIoDispatcher();
    if (!dispatcher)
      throw new DomainError("PLATFORM_LOG_UNAVAILABLE", "日志工作线程尚未启动，请稍后重试。");
    try {
      return (await dispatcher.call(method, args)) as Awaited<
        ReturnType<AsyncAttemptLogStore[Method]>
      >;
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string")
        throw new DomainError(error.code, error.message, { cause: error });
      throw new DomainError("PLATFORM_LOG_UNAVAILABLE", "日志服务暂不可用，请稍后重试。", {
        cause: error,
      });
    }
  }
  return {
    appendChunks: (...args) => call("appendChunks", args),
    listChunks: (...args) => call("listChunks", args),
    acknowledgedSequence: (...args) => call("acknowledgedSequence", args),
    recordWatermarks: (...args) => call("recordWatermarks", args),
    removeBatchStore: (...args) => call("removeBatchStore", args),
    batchStoreStats: (...args) => call("batchStoreStats", args),
    directoryBytes: (...args) => call("directoryBytes", args),
    relativeStorePath(batchId) {
      return relativeAttemptLogStorePath(directory, batchId);
    },
    close: async () => {
      /* The custom server owns and drains the shared I/O pool. */
    },
  };
}
