import { logDatabaseStatusSchema, type LogDatabaseStatus } from "@autoforge/contracts";
import { readApiError } from "./client-api";

type PendingStatusRequest = {
  signal: AbortSignal;
  cancel(): void;
  run(): Promise<void>;
};

/** A page may contain fifty servers. Queue their probes instead of starting fifty HTTP requests. */
export class LogDatabaseStatusClient {
  private readonly queue: PendingStatusRequest[] = [];
  private active = 0;

  constructor(private readonly request: typeof fetch = (input, init) => fetch(input, init)) {}

  read(databaseId: string, force: boolean, signal: AbortSignal): Promise<LogDatabaseStatus> {
    signal.throwIfAborted();
    if (this.queue.length >= 100)
      return Promise.reject(new Error("日志库监控请求繁忙，请稍后重试。"));
    return new Promise<LogDatabaseStatus>((resolve, reject) => {
      const entry: PendingStatusRequest = {
        signal,
        cancel: () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
        },
        run: async () => {
          signal.removeEventListener("abort", entry.cancel);
          try {
            signal.throwIfAborted();
            const response = await this.request(
              `/api/v1/settings/log-databases/${encodeURIComponent(databaseId)}/status${force ? "?refresh=1" : ""}`,
              { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) },
            );
            if (!response.ok) throw await readApiError(response, "读取日志库监控失败。");
            resolve(logDatabaseStatusSchema.parse(await response.json()));
          } catch (cause) {
            reject(cause);
          }
        },
      };
      signal.addEventListener("abort", entry.cancel, { once: true });
      if (force) this.queue.unshift(entry);
      else this.queue.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < 2 && this.queue.length) {
      const entry = this.queue.shift()!;
      this.active++;
      void entry.run().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

export const logDatabaseStatusClient = new LogDatabaseStatusClient();
