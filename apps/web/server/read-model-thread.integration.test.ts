import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createSqliteDatabase, SqliteReadModelSnapshotRepository } from "@autoforge/db/sqlite";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";

it("publishes an invalidated TestNG directory while ordinary background work remains paused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-directory-pressure-"));
  const databasePath = join(directory, "platform.sqlite");
  const migrationsFolder = resolve("packages/db/drizzle/sqlite");
  const handle = createSqliteDatabase({ databasePath, migrationsFolder, busyTimeoutMs: 25 });
  const snapshots = new SqliteReadModelSnapshotRepository(handle);
  const prioritySignal = new SharedArrayBuffer(8);
  const paused = new Int32Array(prioritySignal);
  Atomics.store(paused, 0, 1);
  const worker = new Worker(
    new URL("../dist-server/server/read-model-thread.js", import.meta.url),
    {
      workerData: {
        mode: "lite",
        databasePath,
        migrationsFolder,
        prioritySignal,
        buildInitial: true,
        refreshFacts: false,
      },
      stderr: true,
    },
  );
  const failures: string[] = [];
  worker.stderr.on("data", (chunk: Buffer) => failures.push(chunk.toString()));
  worker.on("error", (error) => failures.push(error.message));
  try {
    const id = "directory-under-execution-pressure";
    await snapshots.request(
      id,
      {
        kind: "case_directory",
        projectId: DEFAULT_PROJECT_ID,
        projectVersionId: "version",
        testStageId: "stage",
        tree: true,
      },
      new Date().toISOString(),
    );
    await vi.waitFor(
      async () => expect((await snapshots.get(id))?.generation).toEqual(expect.any(String)),
      { timeout: 10000 },
    );
    const first = (await snapshots.get(id))!;
    expect(first.payload).toMatchObject({ caseCount: 0, rootOrdinal: expect.any(Number) });
    await snapshots.invalidate(DEFAULT_PROJECT_ID, new Date().toISOString());
    await vi.waitFor(
      async () => {
        const refreshed = (await snapshots.get(id))!;
        expect(refreshed.generatedRevision).toBe(refreshed.requestedRevision);
        expect(refreshed.generation).not.toBe(first.generation);
      },
      { timeout: 10000 },
    );
    expect(Atomics.load(paused, 0)).toBe(1);
    expect(failures).toEqual([]);
  } finally {
    await worker.terminate();
    handle.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("defers real snapshot writer contention, recovers publication and still reports non-lock failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-snapshot-contention-"));
  const databasePath = join(directory, "platform.sqlite");
  const migrationsFolder = resolve("packages/db/drizzle/sqlite");
  const handle = createSqliteDatabase({ databasePath, migrationsFolder, busyTimeoutMs: 25 });
  const writer = new Database(databasePath);
  const snapshots = new SqliteReadModelSnapshotRepository(handle);
  const prioritySignal = new SharedArrayBuffer(8);
  const paused = new Int32Array(prioritySignal);
  const request = (id: string) =>
    snapshots.request(
      id,
      {
        kind: "public_statistics",
        projectId: DEFAULT_PROJECT_ID,
        refreshSeconds: 3600,
      },
      new Date().toISOString(),
    );
  const events: Array<{ kind: string }> = [];
  const errors: Error[] = [];
  const worker = new Worker(
    new URL("../dist-server/server/read-model-thread.js", import.meta.url),
    {
      workerData: { mode: "lite", databasePath, migrationsFolder, prioritySignal },
      stderr: true,
    },
  );
  worker.on("message", (event: { kind: string }) => events.push(event));
  worker.on("error", (error: Error) => errors.push(error));
  // Consume structured diagnostics without mixing the deliberately injected failure into test output.
  const diagnostics: string[] = [];
  worker.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString()));
  try {
    await request("warmup");
    await vi.waitFor(
      async () => expect((await snapshots.get("warmup"))?.generatedAt).toEqual(expect.any(String)),
      { timeout: 10_000 },
    );
    Atomics.store(paused, 0, 1);
    await request("contended");
    writer.exec("BEGIN IMMEDIATE");
    Atomics.store(paused, 0, 0);
    await vi.waitFor(
      () =>
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: "database_contention",
            context: expect.objectContaining({
              database: "sqlite",
              errorCode: "SQLITE_BUSY",
              operation: expect.stringMatching(/^snapshot\./),
            }),
          }),
        ),
      {
        timeout: 5_000,
      },
    );
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "background_refresh" }));
    writer.exec("COMMIT");
    await vi.waitFor(
      async () =>
        expect((await snapshots.get("contended"))?.generatedAt).toEqual(expect.any(String)),
      { timeout: 5_000 },
    );

    Atomics.store(paused, 0, 1);
    await request("broken");
    writer.exec(
      "CREATE TRIGGER reject_snapshot_claim BEFORE UPDATE OF lease_token ON read_model_snapshots WHEN NEW.id='broken' BEGIN SELECT RAISE(ABORT,'injected non-lock failure'); END",
    );
    Atomics.store(paused, 0, 0);
    await vi.waitFor(
      () => expect(events).toContainEqual(expect.objectContaining({ kind: "background_refresh" })),
      {
        timeout: 5_000,
      },
    );
    await vi.waitFor(() => expect(diagnostics.join("")).toContain("injected non-lock failure"));
    expect(errors).toEqual([]);
  } finally {
    if (writer.inTransaction) writer.exec("ROLLBACK");
    try {
      await worker.terminate();
    } finally {
      writer.close();
      handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
