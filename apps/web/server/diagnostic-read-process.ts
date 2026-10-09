import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { WorkRequest, WorkThreadConfiguration } from "./work-protocol.ts";

/** Killing a process interrupts native SQLite calls; terminating a Worker cannot do that. */
export class DiagnosticReadProcess extends EventEmitter {
  private readonly child: ChildProcess;
  private exited = false;

  constructor(configuration: WorkThreadConfiguration, heapMb: number) {
    super();
    this.child = fork(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../dist-server/server/runner-diagnostics-process.js"
          : "./runner-diagnostics-process.js",
        import.meta.url,
      ),
      {
        serialization: "advanced",
        execArgv: [`--max-old-space-size=${heapMb}`],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
    );
    this.child.on("message", (response) => this.emit("message", response));
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("exit", (code) => {
      this.exited = true;
      this.emit("exit", code ?? 1);
    });
    // Only database access is needed here; object-store and terminal credentials stay in their owner.
    this.send({
      configuration: {
        mode: configuration.mode,
        migrationsFolder: configuration.migrationsFolder,
        ...(configuration.mode === "lite"
          ? { databasePath: configuration.sqlite?.databasePath }
          : { databaseUrl: configuration.full?.databaseUrl }),
      },
    });
  }

  postMessage(request: WorkRequest | { id: number; cancel: true }): void {
    this.send(request);
  }

  async terminate(): Promise<number> {
    if (this.exited) return 0;
    return new Promise((resolve) => {
      this.once("exit", resolve);
      this.child.kill("SIGKILL");
    });
  }

  private send(message: object): void {
    this.child.send(message, (error) => {
      if (error && !this.exited) this.emit("error", error);
    });
  }
}
