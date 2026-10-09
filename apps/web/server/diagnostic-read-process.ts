import { InterruptibleReadProcess } from "./interruptible-read-process.ts";
import type { WorkThreadConfiguration } from "./work-protocol.ts";

export class DiagnosticReadProcess extends InterruptibleReadProcess {
  constructor(configuration: WorkThreadConfiguration, heapMb: number) {
    super(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../dist-server/server/runner-diagnostics-process.js"
          : "./runner-diagnostics-process.js",
        import.meta.url,
      ),
      {
        mode: configuration.mode,
        migrationsFolder: configuration.migrationsFolder,
        ...(configuration.mode === "lite"
          ? { databasePath: configuration.sqlite?.databasePath }
          : { databaseUrl: configuration.full?.databaseUrl }),
      },
      heapMb,
    );
  }
}
