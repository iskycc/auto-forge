import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { SqliteWebhookRepository } from "../src/sqlite-webhook";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import { SqliteReadModelSnapshotRepository } from "../src/sqlite-read-model-snapshots";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";

const recordedAt = "2026-09-08T00:00:00.000Z";

async function database() {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-heartbeat-contention-"));
  const databasePath = join(directory, "platform.sqlite");
  const handle = createSqliteDatabase({
    databasePath,
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    busyTimeoutMs: 25,
  });
  const writer = new Database(databasePath);
  const runners = new SqliteRunnerRepository(handle);
  for (let index = 0; index < 8; index++) {
    await runners.register({
      id: `runner-${index}`,
      bootstrapTokenHash: `bootstrap-${index}`,
      credentialHash: `credential-${index}`,
      name: `Runner ${index}`,
      os: "linux",
      architecture: "amd64",
      agentVersion: "1.13.2",
      protocolVersion: 1,
      labels: [],
      capabilities: [],
      maxConcurrency: 10,
      terminalEnabled: false,
      recordedAt,
    });
  }
  return {
    handle,
    writer,
    runners,
    heartbeat: (index: number) =>
      runners.heartbeat({
        runnerId: `runner-${index}`,
        labels: ["retained"],
        capabilities: [],
        maxConcurrency: 10,
        busySlots: 2,
        agentVersion: "1.13.2",
        terminalEnabled: false,
        recordedAt: "2026-09-08T00:00:15.000Z",
      }),
    async close() {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Runner heartbeat under SQLite writer contention", () => {
  it("lets eight existing Runners recover within the heartbeat request after a short writer lock", async () => {
    const harness = await database();
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      harness.writer.exec("BEGIN IMMEDIATE");
      // Releasing from the same event loop proves retries yield instead of busy-waiting.
      release = setTimeout(() => harness.writer.exec("COMMIT"), 100);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) => harness.heartbeat(index)),
      );
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      for (let index = 0; index < 8; index++) {
        expect(
          await harness.runners.findByCredentialHash(`credential-${index}`, recordedAt),
        ).toMatchObject({
          id: `runner-${index}`,
          busySlots: 2,
          labels: ["retained"],
          lastSeenAt: "2026-09-08T00:00:15.000Z",
        });
      }
    } finally {
      clearTimeout(release);
      await harness.close();
    }
  });

  it("bounds persistent contention and accepts a subsequent heartbeat without reinstalling the Runner", async () => {
    const harness = await database();
    try {
      harness.writer.exec("BEGIN IMMEDIATE");
      await expect(harness.heartbeat(0)).rejects.toThrow();
      harness.writer.exec("COMMIT");
      await expect(harness.heartbeat(0)).resolves.toMatchObject({ id: "runner-0", busySlots: 2 });
      expect(await harness.runners.findByCredentialHash("credential-0", recordedAt)).toMatchObject({
        id: "runner-0",
      });
    } finally {
      await harness.close();
    }
  }, 5_000);

  it("does not acquire the writer for any empty retention category", async () => {
    const harness = await database();
    try {
      const operations = new SqlitePlatformOperationsRepository(harness.handle);
      harness.writer.exec("BEGIN IMMEDIATE");
      const results = await Promise.allSettled(
        (
          [
            "artifact",
            "log",
            "analytics",
            "execution",
            "source",
            "session",
            "queue",
            "audit",
          ] as const
        ).map((category) =>
          operations.executeRetention({ category, cutoffAt: recordedAt, recordedAt, limit: 20 }),
        ),
      );
      expect(results).toEqual(
        Array.from({ length: 8 }, () => ({
          status: "fulfilled",
          value: { deletedRecords: 0, objectKeys: [] },
        })),
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps idle maintenance read-only while another connection holds the writer", async () => {
    const harness = await database();
    try {
      const operations = new SqlitePlatformOperationsRepository(harness.handle);
      const webhooks = new SqliteWebhookRepository(harness.handle);
      harness.writer.exec("BEGIN IMMEDIATE");
      const results = await Promise.allSettled([
        new SqliteReadModelSnapshotRepository(harness.handle).cleanup(recordedAt, 20),
        operations.generateNotifications({
          now: recordedAt,
          runnerOfflineBefore: recordedAt,
          limit: 100,
        }),
        operations.claimRetentionCleanupJobs({
          now: recordedAt,
          owner: "maintenance",
          leaseExpiresAt: "2026-09-08T00:02:00.000Z",
          limit: 20,
        }),
        webhooks.materializeDeliveries({ now: recordedAt, limit: 100 }),
        webhooks.claimDueDeliveries({
          now: recordedAt,
          owner: "webhooks",
          leaseExpiresAt: "2026-09-08T00:02:00.000Z",
          limit: 20,
        }),
      ]);
      expect(results).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: 0 },
        { status: "fulfilled", value: [] },
        { status: "fulfilled", value: 0 },
        { status: "fulfilled", value: [] },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("does not acquire a writer when snapshot claims and analytics fact refreshes have no work", async () => {
    const harness = await database();
    try {
      harness.writer.exec("BEGIN IMMEDIATE");
      const results = await Promise.allSettled([
        new SqliteReadModelSnapshotRepository(harness.handle).claim(
          recordedAt,
          "2026-09-08T00:02:00.000Z",
          "lease",
        ),
        new SqlitePlatformOperationsRepository(harness.handle).rebuildAnalyticsFacts(100),
      ]);
      expect(results).toEqual([
        { status: "fulfilled", value: null },
        { status: "fulfilled", value: 0 },
      ]);
    } finally {
      await harness.close();
    }
  });
});
