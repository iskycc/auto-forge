import { join } from "node:path";
import type { JarObjectStorePort, LogIngestionPort } from "@autoforge/application";
import type { NatsConnection } from "nats";
import { isolatedAttemptLogs } from "./isolated-attempt-logs";
import { AesGcmSecretCipher } from "./secret-cipher-core";

/** Full composition only: isolated log-write pools do not consume control connections. */
export async function createFullLogIngestion(input: {
  databaseUrl: string;
  migrationsFolder: string;
  dataDirectory: string;
  masterKey: string;
  objects: JarObjectStorePort;
  connection: NatsConnection;
  reportError(error: unknown): void;
}): Promise<
  LogIngestionPort & {
    close(): Promise<void>;
    connectionPoolSnapshot(): { pools: number; connections: number; idle: number; waiting: number };
  }
> {
  const {
    createPostgresDatabase,
    PostgresLogDatabaseRepository,
    logStoragePlatformId,
    PostgresRoutedAttemptLogStore,
    ArchivedAttemptLogStore,
    PostgresLogArchiveRepository,
    readOnlyLegacyAttemptLogs,
  } = await import("@autoforge/db/postgres");
  const { JetStreamLogIngestion } = await import("@autoforge/queue/log-ingestion");
  const database = createPostgresDatabase({
    connectionString: input.databaseUrl,
    migrationsFolder: input.migrationsFolder,
    poolMax: 8,
  });
  database.pool.on("error", (cause) =>
    input.reportError(
      new Error("Log ingestion idle connection lost; the pool will reconnect.", { cause }),
    ),
  );
  try {
    await database.ready;
  } catch (cause) {
    await database.close();
    throw cause;
  }
  const registry = new PostgresLogDatabaseRepository(
    database,
    new AesGcmSecretCipher(input.masterKey),
    logStoragePlatformId(input.masterKey),
    join(input.migrationsFolder, "../log-postgresql"),
    undefined,
    8,
  );
  const original = new PostgresRoutedAttemptLogStore(
    registry,
    readOnlyLegacyAttemptLogs(isolatedAttemptLogs(join(input.dataDirectory, "attempt-logs"))),
  );
  const logs = new ArchivedAttemptLogStore(
    original,
    new PostgresLogArchiveRepository(database),
    input.objects,
  );
  try {
    const ingestion = await JetStreamLogIngestion.create({
      connection: input.connection,
      objects: input.objects,
      persist: (payload) => logs.appendChunks(payload),
      reportError: input.reportError,
      concurrency: 8,
    });
    return {
      persist: (payload) => ingestion.persist(payload),
      connectionPoolSnapshot: () => registry.connectionPoolSnapshot(),
      async close() {
        try {
          await ingestion.close();
        } finally {
          try {
            await logs.close();
          } finally {
            await database.close();
          }
        }
      },
    };
  } catch (cause) {
    try {
      await logs.close();
    } finally {
      await database.close();
    }
    throw cause;
  }
}
