import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";

describe("Runner scheduling log read plan", () => {
  it("seeks by batch and Runner without visiting other nodes or sorting history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-diagnostic-plan-"));
    const database = createSqliteDatabase({
      databasePath: join(directory, "platform.sqlite"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
    });
    try {
      for (const direction of ["ASC", "DESC"]) {
        const plan = database.client
          .prepare(
            `EXPLAIN QUERY PLAN
          SELECT id, message FROM scheduling_events
          WHERE batch_id = ? AND runner_id = ? AND (recorded_at, id) < (?, ?)
          ORDER BY recorded_at ${direction}, id ${direction} LIMIT 500`,
          )
          .all("batch", "runner", "2026-10-09T00:00:00.000Z", "cursor") as Array<{
          detail: string;
        }>;
        expect(plan.map((step) => step.detail).join("\n")).toContain(
          "scheduling_events_batch_runner_idx",
        );
        expect(plan.some((step) => step.detail.includes("TEMP B-TREE"))).toBe(false);
      }
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
