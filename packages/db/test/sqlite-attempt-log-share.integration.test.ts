import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDatabase } from "../src/database";
import { SqliteAttemptLogShareRepository } from "../src/sqlite-attempt-log-share";
import { attemptLogShareContract, type AttemptLogShareHarness } from "./attempt-log-share.contract";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createHandle() {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-share-"));
  temporaryDirectories.push(directory);
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "autoforge.sqlite"),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
  });
  // 最小外键链：runner -> run_batches -> execution_runs -> run_attempts（两条 run/attempt）。
  handle.client
    .prepare(
      `INSERT INTO runners
       (id, credential_hash, name, disabled, draining, os, architecture, agent_version,
        protocol_version, labels_json, capabilities_json, max_concurrency, busy_slots,
        last_seen_at, created_at, updated_at)
       VALUES ('runner-1', 'hash', 'Runner One', 0, 0, 'linux', 'amd64', '0.4.0',
               1, '{}', '[]', 2, 0, '2026-08-17T00:00:00.000Z',
               '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    )
    .run();
  handle.client
    .prepare(
      `INSERT INTO run_batches
       (id, suite_id, suite_name, suite_version, status, retry_limit, total_runs,
        environment_json, created_at, updated_at)
       VALUES ('batch-1', 'suite-1', '回归套件', 1, 'running', 3, 2, '[]',
               '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    )
    .run();
  handle.client
    .prepare(
      `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        status, attempt_count, created_at, updated_at)
       VALUES ('run-1', 'batch-1', 'case-1', 1, 'run-1#method', 'com.example.RunOne',
               'running', 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    )
    .run();
  handle.client
    .prepare(
      `INSERT INTO run_attempts
       (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
       VALUES ('attempt-1', 'run-1', 'runner-1', 1, 'running', 1.0, '2026-08-17T00:00:00.000Z')`,
    )
    .run();
  handle.client
    .prepare(
      `INSERT INTO execution_runs
       (id, batch_id, case_definition_id, case_version, display_name, class_name,
        status, attempt_count, created_at, updated_at)
       VALUES ('run-2', 'batch-1', 'case-2', 1, 'run-2#method', 'com.example.RunTwo',
               'running', 1, '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z')`,
    )
    .run();
  handle.client
    .prepare(
      `INSERT INTO run_attempts
       (id, execution_run_id, runner_id, attempt_number, status, scheduling_score, created_at)
       VALUES ('attempt-2', 'run-2', 'runner-1', 1, 'running', 1.0, '2026-08-17T00:00:00.000Z')`,
    )
    .run();
  return handle;
}

function sqliteHarness(): Promise<AttemptLogShareHarness> {
  return createHandle().then((handle): AttemptLogShareHarness => {
    return {
      repository: new SqliteAttemptLogShareRepository(handle),
      fixture: { batchId: "batch-1", attemptIds: ["attempt-1", "attempt-2"] },
      async dispose() {
        handle.close();
      },
    };
  });
}

attemptLogShareContract("SQLite attempt log share", sqliteHarness);

function shareRecord(overrides: Record<string, string> = {}) {
  return {
    id: "share-1",
    tokenHash: "hash-a",
    attemptId: "attempt-1",
    batchId: "batch-1",
    createdBy: "user-1",
    createdAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("SqliteAttemptLogShareRepository", () => {
  it("returns the newest active share for an attempt and ignores expired rows", async () => {
    const handle = await createHandle();
    const repository = new SqliteAttemptLogShareRepository(handle);
    try {
      await repository.create(
        shareRecord({
          id: "share-old",
          tokenHash: "hash-old",
          createdAt: "2026-08-16T00:00:00.000Z",
        }),
      );
      await repository.create(
        shareRecord({
          id: "share-new",
          tokenHash: "hash-new",
          createdAt: "2026-08-17T01:00:00.000Z",
        }),
      );
      await repository.create(
        shareRecord({
          id: "share-expired",
          tokenHash: "hash-expired",
          createdAt: "2026-08-17T02:00:00.000Z",
          expiresAt: "2026-08-17T03:00:00.000Z",
        }),
      );

      const active = await repository.findActiveByAttemptId(
        "attempt-1",
        "2026-08-17T04:00:00.000Z",
      );
      // 最新创建的有效记录优先；expires_at 已过的行即使更晚创建也不返回。
      expect(active?.id).toBe("share-new");

      const byToken = await repository.findActiveByTokenHash(
        "hash-new",
        "2026-08-17T04:00:00.000Z",
      );
      expect(byToken?.attemptId).toBe("attempt-1");
    } finally {
      handle.close();
    }
  });

  it("treats shares past expires_at as inactive", async () => {
    const handle = await createHandle();
    const repository = new SqliteAttemptLogShareRepository(handle);
    try {
      await repository.create(shareRecord());
      expect(
        await repository.findActiveByTokenHash("hash-a", "2026-09-17T00:00:00.000Z"),
      ).toBeNull();
      expect(
        await repository.findActiveByAttemptId("attempt-1", "2026-09-17T00:00:00.000Z"),
      ).toBeNull();
    } finally {
      handle.close();
    }
  });

  it("removes shares when the attempt is deleted", async () => {
    const handle = await createHandle();
    const repository = new SqliteAttemptLogShareRepository(handle);
    try {
      await repository.create(shareRecord());
      handle.client.prepare("DELETE FROM run_attempts WHERE id = 'attempt-1'").run();
      expect(
        await repository.findActiveByTokenHash("hash-a", "2026-08-17T00:00:00.000Z"),
      ).toBeNull();
    } finally {
      handle.close();
    }
  });

  it("enforces token hash uniqueness", async () => {
    const handle = await createHandle();
    const repository = new SqliteAttemptLogShareRepository(handle);
    try {
      await repository.create(shareRecord());
      await expect(repository.create(shareRecord({ id: "share-dup" }))).rejects.toThrow();
    } finally {
      handle.close();
    }
  });
});
