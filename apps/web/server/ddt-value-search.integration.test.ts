import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { ddtValueSearchPageSchema } from "@autoforge/contracts";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../../../packages/db/src/database";
import { SqliteProjectStructureRepository } from "../../../packages/db/src/sqlite-project-structure";
import { WorkerPool } from "./worker-pool";
import { webResourcePlan } from "../src/lib/worker-sizing";

it("scans 100,000 DDT cases off the Web thread, bounds admission and leaves SQLite writes available", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-search-worker-"));
  const databasePath = resolve(directory, "platform.sqlite");
  const migrationsFolder = resolve("packages/db/drizzle/sqlite");
  const handle = createSqliteDatabase({ databasePath, migrationsFolder });
  const structures = new SqliteProjectStructureRepository(handle);
  const now = "2026-09-16T00:00:00.000Z";
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: "version",
    testStageId: "stage",
  };
  const pool = new WorkerPool(
    {
      mode: "lite",
      dataDirectory: directory,
      migrationsFolder,
      attemptLogsDirectory: resolve(directory, "logs"),
      sqlite: { databasePath },
      caseExecutionTimeoutSeconds: 60,
      artifactCollectionEnabled: false,
      scheduler: {
        maximumCpuUtilizationPercent: 90,
        maximumMemoryUtilizationPercent: 90,
        maximumLoadPerCpu: 2,
        metricsMaximumAgeSeconds: 60,
        projectMaximumConcurrency: 500,
        priorityAgingIntervalMinutes: 1,
      },
    },
    1,
    5_000,
    webResourcePlan({ cpuCapacity: 1, memoryCapacityBytes: 4 * 1024 ** 3 }, "lite"),
  );
  const server = createServer((_request, response) => response.end("responsive"));
  try {
    await structures.createVersion({
      id: "version",
      projectId: scope.projectId,
      name: "version",
      normalizedName: "version",
      recordedAt: now,
    });
    await structures.createStage({
      ...scope,
      id: "stage",
      name: "stage",
      normalizedName: "stage",
      description: "",
      recordedAt: now,
    });
    const insert = handle.client.prepare(`INSERT INTO ddt_cases
      (id, project_id, project_version_id, test_stage_id, case_id, case_id_normalized, sr_num, sr_num_normalized, case_kind, data_json, created_at, updated_at)
      VALUES (?, ?, 'version', 'stage', ?, ?, 'SR', 'sr', 'standard', ?, ?, ?)`);
    const body = JSON.stringify({ description: "ordinary value".repeat(30) });
    handle.client.transaction(() => {
      for (let index = 0; index < 100_000; index += 1) {
        const caseId = `case-${String(index).padStart(6, "0")}`;
        insert.run(
          caseId,
          scope.projectId,
          caseId,
          caseId,
          index === 99_999 ? JSON.stringify({ field: "unique-needle" }) : body,
          now,
          now,
        );
      }
    })();
    const signal = new AbortController().signal;
    const input = { ...scope, keyword: "unique-needle", limit: 20 };
    const first = pool.searchDdtValues(input, signal);
    const second = pool.searchDdtValues({ ...input, keyword: "missing" }, signal);
    const settled = Promise.all([first, second]);
    await expect(pool.searchDdtValues(input, signal)).rejects.toMatchObject({
      code: "PLATFORM_BUSY",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP probe address");
    const latencies: number[] = [];
    for (let probe = 0; probe < 12; probe += 1) {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        signal: AbortSignal.timeout(1_500),
      });
      expect(await response.text()).toBe("responsive");
      handle.client
        .prepare("UPDATE test_stages SET description = ? WHERE id = 'stage'")
        .run(String(probe));
      latencies.push(performance.now() - started);
    }
    expect(Math.max(...latencies)).toBeLessThan(1_500);
    let page = ddtValueSearchPageSchema.parse((await settled)[0]);
    let scanned = page.scannedCount;
    const matches = [...page.items];
    for (let slice = 0; page.nextCursor && slice < 100; slice += 1) {
      page = ddtValueSearchPageSchema.parse(
        await pool.searchDdtValues({ ...input, cursor: page.nextCursor }, signal),
      );
      scanned += page.scannedCount;
      matches.push(...page.items);
    }
    expect(page.nextCursor).toBeUndefined();
    expect(scanned).toBe(100_000);
    expect(matches.map((item) => item.caseId)).toEqual(["case-099999"]);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(pool.searchDdtValues(input, cancelled.signal)).rejects.toThrow();
    const recovery = ddtValueSearchPageSchema.parse(
      await pool.searchDdtValues({ ...input, cursor: "case-099998" }, signal),
    );
    expect(recovery.items).toHaveLength(1);
  } finally {
    await pool.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    handle.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
