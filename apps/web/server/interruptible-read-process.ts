import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/** A process boundary makes synchronous native reads interruptible without terminating a writer. */
export class InterruptibleReadProcess extends EventEmitter {
  private readonly child: ChildProcess;
  private exited = false;
  constructor(entrypoint: URL, configuration: object, heapMb: number) {
    super();
    this.child = fork(entrypoint, {
      serialization: "advanced",
      execArgv: [`--max-old-space-size=${heapMb}`],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child.on("message", (response) => this.emit("message", response));
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("exit", (code) => {
      this.exited = true;
      this.emit("exit", code ?? 1);
    });
    this.postMessage({ configuration });
  }
  postMessage(message: object): void {
    this.child.send(message, (error) => {
      if (error && !this.exited) this.emit("error", error);
    });
  }
  async terminate(): Promise<number> {
    if (this.exited) return 0;
    return new Promise((resolve) => {
      this.once("exit", resolve);
      this.child.kill("SIGKILL");
    });
  }
}
