import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteDatabase, SqliteReadModelSnapshotRepository } from "@autoforge/db/sqlite";
import {
  createPostgresDatabase,
  PostgresReadModelSnapshotRepository,
} from "@autoforge/db/postgres";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

beforeAll(async () => {
  await promisify(execFile)("pnpm", ["--filter", "@autoforge/worker", "build"], {
    cwd: repositoryRoot,
    timeout: 60_000,
  });
}, 65_000);

for (const mode of ["lite", "full"] as const) {
  describe.skipIf(mode === "full" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${mode} production snapshot thread`,
    () => {
      it("publishes snapshots and stops without starting another worker entrypoint", async () => {
        const harness = await createHarness(mode);
        const errors: Error[] = [];
        const diagnostics: string[] = [];
        const worker = new Worker(new URL("../dist/read-model-thread.js", import.meta.url), {
          workerData: { ...harness.configuration, prioritySignal: new SharedArrayBuffer(8) },
          stderr: true,
        });
        let exitCode: number | undefined;
        worker.on("error", (error: Error) => errors.push(error));
        worker.on("exit", (code) => {
          exitCode = code;
        });
        worker.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString()));
        try {
          const id = randomUUID();
          await harness.snapshots.request(
            id,
            {
              kind: "public_statistics",
              projectId: DEFAULT_PROJECT_ID,
              refreshSeconds: 3600,
            },
            new Date().toISOString(),
          );
          await vi.waitFor(
            async () => {
              expect(errors, diagnostics.join("")).toEqual([]);
              expect(exitCode).toBeUndefined();
              expect((await harness.snapshots.get(id))?.generatedAt).toEqual(expect.any(String));
            },
            { timeout: 10_000 },
          );
          worker.postMessage("stop");
          await vi.waitFor(() => expect(exitCode).toBe(0), { timeout: 5_000 });
          expect(errors).toEqual([]);
          expect(diagnostics).toEqual([]);
        } finally {
          try {
            await worker.terminate();
          } finally {
            await harness.close();
          }
        }
      }, 25_000);
    },
  );
}

async function createHarness(mode: "lite" | "full") {
  if (mode === "lite") {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-snapshot-bundle-"));
    const configuration = {
      mode,
      databasePath: join(directory, "platform.sqlite"),
      migrationsFolder: join(repositoryRoot, "packages/db/drizzle/sqlite"),
    };
    const handle = createSqliteDatabase(configuration);
    return {
      configuration,
      snapshots: new SqliteReadModelSnapshotRepository(handle),
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const migrationsFolder = join(repositoryRoot, "packages/db/drizzle/postgresql");
  const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL!;
  const admin = createPostgresDatabase({ connectionString, migrationsFolder, poolMax: 1 });
  const schema = `snapshot_bundle_${randomUUID().replaceAll("-", "")}`;
  try {
    await admin.ready;
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const configuration = { mode, databaseUrl: url.toString(), migrationsFolder, poolMax: 1 };
    const handle = createPostgresDatabase({ ...configuration, connectionString: url.toString() });
    try {
      await handle.ready;
    } catch (error) {
      await handle.close();
      throw error;
    }
    return {
      configuration,
      snapshots: new PostgresReadModelSnapshotRepository(handle),
      close: async () => {
        try {
          await handle.close();
          await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          await admin.close();
        }
      },
    };
  } catch (error) {
    try {
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.close();
    }
    throw error;
  }
}
