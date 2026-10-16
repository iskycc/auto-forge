import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresRunnerRepository } from "../src/postgres-platform-repository";

const recordedAt = "2026-10-15T00:00:00.000Z";
const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;

type Harness = {
  repository: RunnerRepository;
  purge(id: string): Promise<void>;
  dispose(): Promise<void>;
};

for (const adapter of ["sqlite", "postgres"] as const) {
  describe.skipIf(adapter === "postgres" && !connectionString)(
    `${adapter} Runner cursor pages`,
    () => {
      it("bounds pages, excludes purged nodes and preserves heartbeat state across cursors", async () => {
        const harness = await createHarness(adapter);
        try {
          for (const id of ["runner-c", "runner-a", "runner-b"]) {
            await harness.repository.register({
              id,
              bootstrapTokenHash: `bootstrap-${id}`,
              credentialHash: `credential-${id}`,
              name: id,
              os: "linux",
              architecture: "amd64",
              agentVersion: "1.19.22",
              protocolVersion: 1,
              labels: ["java", "testng"],
              capabilities: [],
              maxConcurrency: 2,
              terminalEnabled: false,
              recordedAt,
            });
          }
          await harness.purge("runner-b");
          const first = await harness.repository.listPage(recordedAt, { limit: 1 });
          expect(first.items.map((runner) => runner.id)).toEqual(["runner-a"]);
          expect(first.items[0]!.state).toBe("online");
          expect(first.nextCursor).toBe("runner-a");
          const second = await harness.repository.listPage("2026-10-15T00:01:00.000Z", {
            afterId: first.nextCursor!,
            limit: 1,
          });
          expect(second.items.map((runner) => runner.id)).toEqual(["runner-c"]);
          expect(second.items[0]!.state).toBe("offline");
          expect(second.nextCursor).toBeUndefined();
          expect(
            await harness.repository.listPage(recordedAt, { afterId: "runner-z", limit: 64 }),
          ).toEqual({ items: [] });
          expect((await harness.repository.listPage(recordedAt, { limit: 0 })).items).toHaveLength(
            1,
          );
        } finally {
          await harness.dispose();
        }
      });
    },
  );
}

async function createHarness(adapter: "sqlite" | "postgres"): Promise<Harness> {
  if (adapter === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-runner-page-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "platform.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      repository: new SqliteRunnerRepository(handle),
      async purge(id) {
        handle.client.prepare("UPDATE runners SET purged_at = ? WHERE id = ?").run(recordedAt, id);
      },
      async dispose() {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const migrationsFolder = resolve(import.meta.dirname, "../drizzle/postgresql");
  const administrator = createPostgresDatabase({
    connectionString: connectionString!,
    migrationsFolder,
    poolMax: 2,
  });
  await administrator.ready;
  const databaseName = `runner_page_${randomUUID().replaceAll("-", "")}`;
  await administrator.pool.query(`CREATE DATABASE "${databaseName}"`);
  const isolatedUrl = new URL(connectionString!);
  isolatedUrl.pathname = `/${databaseName}`;
  const handle = createPostgresDatabase({
    connectionString: isolatedUrl.toString(),
    migrationsFolder,
    poolMax: 2,
  });
  await handle.ready;
  return {
    repository: new PostgresRunnerRepository(handle),
    async purge(id) {
      await handle.pool.query("UPDATE runners SET purged_at = $1 WHERE id = $2", [recordedAt, id]);
    },
    async dispose() {
      await handle.close();
      try {
        await administrator.pool.query(`DROP DATABASE "${databaseName}"`);
      } finally {
        await administrator.close();
      }
    },
  };
}
