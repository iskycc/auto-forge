import { Worker } from "node:worker_threads";
import { runtimePriority } from "../src/lib/runtime-priority.ts";
import type { AiThreadConfiguration } from "./ai-analysis-configuration.ts";

/** AI parsing and SQLite I/O never execute in the Web request event loop. */
export class AiAnalysisWorkerHost {
  private worker: Worker | undefined;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private readonly prioritySignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  private readonly pressureTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly configuration: AiThreadConfiguration,
    private readonly report: (error: unknown) => void,
    private readonly canWork: () => boolean = () => runtimePriority().backgroundAllowed(),
  ) {
    const update = () =>
      Atomics.store(new Int32Array(this.prioritySignal), 0, this.canWork() ? 0 : 1);
    update();
    this.pressureTimer = setInterval(update, 250);
    this.pressureTimer.unref();
    this.start();
  }
  private start() {
    if (this.stopped) return;
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../dist-server/server/ai-analysis-thread.js"
          : "./ai-analysis-thread.js",
        import.meta.url,
      ),
      {
        workerData: { ...this.configuration, prioritySignal: this.prioritySignal },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    this.worker = worker;
    worker.on("message", (event: { error?: string }) => {
      if (event.error) this.report(new Error(event.error));
    });
    worker.on("error", this.report);
    worker.on("exit", (code) => {
      if (this.stopped) return;
      this.report(new Error(`AI worker exited (${code}).`));
      if (++this.failures <= 5)
        this.retry = setTimeout(() => this.start(), Math.min(30000, 1000 * 2 ** this.failures));
    });
  }
  wake() {
    this.worker?.postMessage("wake");
  }
  async close() {
    this.stopped = true;
    clearInterval(this.pressureTimer);
    clearTimeout(this.retry);
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        void worker.terminate().then(
          () => resolve(),
          (error) => {
            this.report(error);
            resolve();
          },
        );
      }, 5000);
      worker.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      worker.postMessage("stop");
    });
  }
}
