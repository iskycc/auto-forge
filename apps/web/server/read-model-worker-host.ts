import { Worker } from "node:worker_threads";

type Configuration = { migrationsFolder: string } & (
  { mode: "lite"; databasePath: string } | { mode: "full"; databaseUrl: string }
);

/** A separate thread prevents SQLite aggregation from blocking HTTP or Runner control work. */
export class ReadModelWorkerHost {
  private worker: Worker | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private failures = 0;

  constructor(
    private readonly configuration: Configuration,
    private readonly reportError: (error: unknown) => void,
  ) {
    this.start();
  }

  private start(): void {
    if (this.stopped) return;
    const worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../dist-server/server/read-model-thread.js"
          : "./read-model-thread.js",
        import.meta.url,
      ),
      { workerData: this.configuration },
    );
    this.worker = worker;
    worker.on("error", this.reportError);
    worker.on("exit", (code) => {
      if (this.stopped) return;
      this.reportError(new Error(`Read model worker exited with code ${code}.`));
      this.failures += 1;
      if (this.failures <= 5)
        this.retry = setTimeout(() => this.start(), Math.min(30_000, 1_000 * 2 ** this.failures));
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        void worker.terminate().then(
          () => resolve(),
          (error: unknown) => {
            this.reportError(error);
            resolve();
          },
        );
      }, 5_000);
      worker.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      worker.postMessage("stop");
    });
  }
}
