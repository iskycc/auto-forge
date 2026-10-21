import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { SqliteDdtRepository } from "../src/sqlite-ddt";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";

it("seeks subsequent DDT pages before resolving execution classes", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-page-"));
  const handle = createSqliteDatabase({
    databasePath: resolve(directory, "db.sqlite"),
    migrationsFolder: resolve("packages/db/drizzle/sqlite"),
  });
  const structures = new SqliteProjectStructureRepository(handle);
  const scope = {
    projectId: DEFAULT_PROJECT_ID,
    projectVersionId: "version",
    testStageId: "stage",
  };
  const now = "2026-10-21T00:00:00.000Z";
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
      (id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at)
      VALUES (?,?,'version','stage',?,?,'SR','sr','standard','{}',?,?)`);
    handle.client.transaction(() => {
      for (let index = 0; index < 100_000; index++) {
        const id = `case-${String(index).padStart(6, "0")}`;
        insert.run(id, scope.projectId, id, id, now, now);
      }
    })();
    const prepare = vi.spyOn(handle.client, "prepare");
    const repository = new SqliteDdtRepository(handle);
    const first = await repository.listCases({ ...scope, filters: [], limit: 60 });
    prepare.mockClear();
    const started = performance.now();
    const second = await repository.listCases({
      ...scope,
      filters: [],
      limit: 60,
      cursor: first.nextCursor!,
    });
    const elapsed = performance.now() - started;
    const sql = prepare.mock.calls[0]![0];
    prepare.mockRestore();
    const plan = handle.client
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(scope.projectId, "version", "stage", first.nextCursor!, 61);
    expect(elapsed).toBeLessThan(1_000);
    expect(
      plan.filter((row) => String((row as { detail: string }).detail).includes("SEARCH mapping")),
    ).toHaveLength(1);
    expect(second.items).toHaveLength(60);
    expect(second.items[0]?.caseId).toBe("case-000060");
    expect(second.nextCursor).toBe("case-000119");
  } finally {
    handle.close();
    await rm(directory, { recursive: true, force: true });
  }
});
