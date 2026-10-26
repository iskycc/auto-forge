import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

type HistoryFixtureConnection = {
  nextBatchSequence: string;
  execute: (statement: string, parameters?: Array<string | number | null>) => Promise<void>;
  close: () => Promise<void>;
};

export async function openHistoryFixtureConnection(input: {
  directory?: string | undefined;
  postgresUrl?: string | undefined;
}): Promise<HistoryFixtureConnection> {
  if (input.directory) {
    const database = new DatabaseSync(resolve(input.directory, "db", "autoforge.sqlite"));
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    return {
      nextBatchSequence: "(SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM run_batches)",
      execute: async (statement, parameters = []) => {
        database.prepare(statement).run(...parameters);
      },
      close: async () => database.close(),
    };
  }
  if (!input.postgresUrl)
    throw new Error(
      "AUTOFORGE_E2E_DATA_DIR or AUTOFORGE_E2E_POSTGRES_URL is required for history fixtures.",
    );
  const { createPostgresDatabase } = await import("@autoforge/db/postgres");
  const database = createPostgresDatabase({
    connectionString: input.postgresUrl,
    migrationsFolder: resolve(import.meta.dirname, "../../../packages/db/drizzle/postgresql"),
    poolMax: 1,
  });
  await database.ready;
  return {
    nextBatchSequence: "nextval('run_batch_sequence_numbers')",
    execute: async (statement, parameters = []) => {
      let index = 0;
      await database.pool.query(
        statement.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    },
    close: () => database.close(),
  };
}
