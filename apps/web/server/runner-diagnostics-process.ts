import { DomainError, isDomainError } from "@autoforge/domain";
import { z } from "zod";
import type { RunBatchRepository, RunnerRepository } from "@autoforge/application";
import type { WorkRequest, WorkResponse, DiagnosticReadConfiguration } from "./work-protocol.ts";

const identifier = z.string().min(1).max(128);
const querySchema = z
  .object({
    batchId: identifier,
    runnerId: identifier.optional(),
    query: z.string().trim().max(256).optional(),
    afterId: identifier.optional(),
    beforeId: identifier.optional(),
    latest: z.boolean().optional(),
    limit: z.number().int().min(1).max(500),
  })
  .strict();
const sampleSchema = z
  .object({ runnerId: identifier, since: z.iso.datetime(), until: z.iso.datetime() })
  .strict();
const configurationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("lite"),
      migrationsFolder: z.string().min(1),
      databasePath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("full"),
      migrationsFolder: z.string().min(1),
      databaseUrl: z.string().min(1),
    })
    .strict(),
]);
let configuration: DiagnosticReadConfiguration | undefined;
let repositories:
  | Promise<{ batches: RunBatchRepository; runners: RunnerRepository; close(): Promise<void> }>
  | undefined;
let requests = Promise.resolve();

process.on("message", (message: { configuration: DiagnosticReadConfiguration } | WorkRequest) => {
  if ("configuration" in message) {
    if (configuration) throw new Error("Diagnostic reader configuration cannot change.");
    configuration = configurationSchema.parse(message.configuration);
    return;
  }
  requests = requests.then(() => respond(message));
});
process.on("disconnect", () => {
  void requests
    .then(async () => {
      if (repositories) await (await repositories).close();
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", requestId: "diagnostic-reader-shutdown", message: "Diagnostic reader shutdown failed", error: error instanceof Error ? error.message : "Unknown error" })}\n`,
      );
      process.exit(1);
    });
});

async function respond(request: WorkRequest): Promise<void> {
  let response: WorkResponse;
  try {
    const value = await read(request);
    response = { id: request.id, ok: true, value };
  } catch (error) {
    const diagnostic =
      error instanceof Error ? error : new Error("诊断读取失败。", { cause: error });
    const code = isDomainError(diagnostic) ? diagnostic.code : Reflect.get(diagnostic, "code");
    response = {
      id: request.id,
      ok: false,
      error: {
        name: diagnostic.name,
        message: diagnostic.message,
        ...(typeof code === "string" ? { code } : {}),
      },
    };
  }
  if (process.connected) process.send?.(response);
}

async function read({ task }: WorkRequest): Promise<unknown> {
  if (task.kind === "warmup") return;
  if (task.kind !== "read-scheduling-events" && task.kind !== "read-runner-resource-samples")
    throw new DomainError("VALIDATION_FAILED", "诊断进程只接受日志和资源监控读取。");
  repositories ??= openRepositories().catch((error: unknown) => {
    repositories = undefined;
    throw error;
  });
  const { batches, runners } = await repositories;
  try {
    if (task.kind === "read-scheduling-events") {
      const input = querySchema.parse(task.input);
      return await batches.listSchedulingEvents({
        batchId: input.batchId,
        limit: input.limit,
        ...(input.runnerId !== undefined ? { runnerId: input.runnerId } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.afterId !== undefined ? { afterId: input.afterId } : {}),
        ...(input.beforeId !== undefined ? { beforeId: input.beforeId } : {}),
        ...(input.latest !== undefined ? { latest: input.latest } : {}),
      });
    }
    const input = sampleSchema.parse(task.input);
    return await runners.resourceSamples(input.runnerId, input.since, input.until);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "57014")
      throw new DomainError("PLATFORM_BUSY", "执行机诊断读取超时，请稍后重试。", { cause: error });
    throw error;
  }
}

async function openRepositories() {
  if (!configuration) throw new Error("Diagnostic reader configuration is missing.");
  if (configuration.mode === "lite") {
    const adapters = await import("@autoforge/db/sqlite");
    const database = adapters.createSqliteDatabase({
      databasePath: configuration.databasePath,
      migrationsFolder: configuration.migrationsFolder,
      access: "read-only",
      busyTimeoutMs: 25,
    });
    return {
      batches: new adapters.SqliteRunBatchRepository(database),
      runners: new adapters.SqliteRunnerRepository(database),
      close: async () => database.close(),
    };
  }
  const adapters = await import("@autoforge/db/postgres");
  const database = adapters.createPostgresDatabase({
    connectionString: configuration.databaseUrl,
    migrationsFolder: configuration.migrationsFolder,
    poolMax: 1,
    access: "read-only",
    statementTimeoutMs: 4_000,
    lockTimeoutMs: 25,
  });
  try {
    await database.ready;
    return {
      batches: new adapters.PostgresRunBatchRepository(database),
      runners: new adapters.PostgresRunnerRepository(database),
      close: () => database.close(),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
