import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteDdtSrTagRepository } from "../src/sqlite-ddt-sr-tags";
import { PostgresDdtSrTagRepository } from "../src/postgres-ddt-sr-tags";

const now = "2026-10-24T00:00:00.000Z";
for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} SR labels`,
    () => {
      it("imports classifications additively, rolls back invalid pages and exports every pair with cursors", async () => {
        const f = await fixture(dialect);
        try {
          const row = (srNum: string, tagName: string, rowNumber: number) => ({
            srNum,
            tagName,
            rowNumber,
            sheetName: "分类",
            tagId: randomUUID(),
          });
          const rows = [
            row("钱包-SR", "Wallet", 2),
            row("钱包-SR", "Smoke", 3),
            row("untagged", "Wallet", 4),
          ];
          expect(await f.repository.importPage(f.scope, rows, now)).toBe(3);
          expect(await f.repository.importPage(f.scope, rows, now)).toBe(0);
          expect(
            await f.repository.classifications({ ...f.scope, projectVersionId: f.otherVersionId }),
          ).toEqual({ items: [] });
          await expect(
            f.repository.importPage(
              f.scope,
              [row("钱包-SR", "Must rollback", 5), row("missing", "Must rollback", 6)],
              now,
            ),
          ).rejects.toMatchObject({ code: "SR_TAG_IMPORT_SR_NOT_FOUND" });
          expect(
            (await f.repository.list(f.scope, { query: "Must rollback", limit: 100 })).items,
          ).toEqual([]);
          // Fail after the tag catalog insert to verify the whole page is rolled back.
          if (dialect === "sqlite")
            await f.execute(
              "CREATE TEMP TRIGGER reject_sr_tag_import BEFORE INSERT ON ddt_sr_tag_assignments BEGIN SELECT RAISE(ABORT,'injected assignment write failure'); END",
            );
          else {
            await f.execute(
              "CREATE FUNCTION reject_sr_tag_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected assignment write failure'; END; $$",
            );
            await f.execute(
              "CREATE TRIGGER reject_sr_tag_import BEFORE INSERT ON ddt_sr_tag_assignments FOR EACH ROW EXECUTE FUNCTION reject_sr_tag_import()",
            );
          }
          try {
            await expect(
              f.repository.importPage(f.scope, [row("钱包-SR", "Atomic rollback", 7)], now),
            ).rejects.toThrow("injected assignment write failure");
            expect(
              (await f.repository.list(f.scope, { query: "Atomic rollback", limit: 100 })).items,
            ).toEqual([]);
          } finally {
            await f.execute(
              dialect === "sqlite"
                ? "DROP TRIGGER reject_sr_tag_import"
                : "DROP TRIGGER reject_sr_tag_import ON ddt_sr_tag_assignments",
            );
            if (dialect === "postgres") await f.execute("DROP FUNCTION reject_sr_tag_import()");
          }
          for (let offset = 0; offset < 205; offset += 100)
            await f.repository.importPage(
              f.scope,
              Array.from({ length: Math.min(100, 205 - offset) }, (_, index) =>
                row("钱包-SR", `分类-${offset + index}`, 10 + offset + index),
              ),
              now,
            );
          const first = await f.repository.classifications(f.scope);
          expect(first.items).toHaveLength(200);
          expect(first.nextCursor).toBeTruthy();
          const last = await f.repository.classifications(f.scope, first.nextCursor);
          expect(last.items).toHaveLength(8);
          expect(last.nextCursor).toBeUndefined();
          const exported = [...first.items, ...last.items];
          expect(exported.filter((entry) => entry.tagName === "Wallet")).toHaveLength(2);
          expect(new Set(exported.map((entry) => JSON.stringify(entry))).size).toBe(208);
        } finally {
          await f.close();
        }
      }, 30000);
      it("upgrades the previous schema while preserving existing task members and cases", async () => {
        const f = await fixture(dialect, true);
        try {
          expect(
            Number(
              (
                await f.execute(
                  "SELECT count(*) AS count FROM ddt_cases WHERE project_version_id=?",
                  [f.scope.projectVersionId],
                )
              )[0]!.count,
            ),
          ).toBe(207);
          const tag = await f.repository.create(
            f.scope,
            { id: randomUUID(), name: "After upgrade" },
            now,
          );
          await f.repository.assign(
            f.scope,
            { tagId: tag.id, srNum: "钱包-SR", assigned: true },
            now,
          );
          expect((await f.repository.lookup(f.scope, ["钱包-SR"]))["钱包-SR"]).toEqual([tag]);
        } finally {
          await f.close();
        }
      }, 30000);
      it("shares multiple labels across stages, isolates versions, and pages task-only include/exclude selections without case bodies", async () => {
        const f = await fixture(dialect);
        const { repository, scope, execute, suiteId } = f;
        try {
          const wallet = await repository.create(scope, { id: randomUUID(), name: "Wallet" }, now);
          const smoke = await repository.create(scope, { id: randomUUID(), name: "Smoke" }, now);
          expect(
            await repository.create(scope, { id: randomUUID(), name: " wallet " }, now),
          ).toEqual(wallet);
          const otherScope = { ...scope, projectVersionId: f.otherVersionId };
          const foreign = await repository.create(
            otherScope,
            { id: randomUUID(), name: "Wallet" },
            now,
          );
          expect(foreign.id).not.toBe(wallet.id);
          await Promise.all(
            [wallet, smoke].map((tag) =>
              repository.assign(scope, { tagId: tag.id, srNum: " 钱包-SR ", assigned: true }, now),
            ),
          );
          await repository.assign(
            scope,
            { tagId: wallet.id, srNum: "钱包-sr", assigned: true },
            now,
          );
          expect(
            (await repository.lookup(scope, ["钱包-SR", "untagged", "__proto__"]))["钱包-SR"],
          ).toEqual([smoke, wallet]);
          expect((await repository.lookup(otherScope, ["钱包-SR"]))["钱包-SR"]).toEqual([]);
          const groups = await repository.groups(scope, { query: "", limit: 1 });
          expect(groups.items).toHaveLength(1);
          expect(groups.nextCursor).toBeTruthy();
          const sr = await repository.groups(scope, { query: "钱包", limit: 40 });
          expect(sr.items).toEqual([{ srNum: "钱包-SR", caseCount: 206, tags: [smoke, wallet] }]);
          const filter = { tagIds: [wallet.id], match: "include" as const, revision: 1 };
          const first = await repository.members(scope, suiteId, filter);
          const last = await repository.members(scope, suiteId, {
            ...filter,
            cursor: first.nextCursor,
          });
          expect(first.items).toHaveLength(200);
          expect(last.items).toHaveLength(5);
          expect(last.nextCursor).toBeUndefined();
          expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(205);
          expect(first.items[0]).not.toHaveProperty("data");
          const complement = await repository.members(scope, suiteId, {
            ...filter,
            match: "exclude",
          });
          expect(complement.items).toEqual([]);
          expect(complement.nextCursor).toBeTruthy();
          expect(
            (
              await repository.members(scope, suiteId, {
                ...filter,
                match: "exclude",
                cursor: complement.nextCursor,
              })
            ).items.map((item) => item.id),
          ).toEqual([f.untaggedId]);
          expect((await repository.members(scope, randomUUID(), filter)).items).toEqual([]);
          expect(
            (await repository.members(scope, suiteId, { ...filter, tagIds: [wallet.id, smoke.id] }))
              .items,
          ).toHaveLength(200);
          await expect(
            repository.members(scope, suiteId, { ...filter, tagIds: [foreign.id] }),
          ).rejects.toMatchObject({ code: "DDT_SR_TAG_NOT_FOUND" });
          await expect(
            repository.assign(scope, { tagId: foreign.id, srNum: "钱包-SR", assigned: true }, now),
          ).rejects.toMatchObject({ code: "DDT_SR_TAG_NOT_FOUND" });
          await expect(
            repository.assign(scope, { tagId: wallet.id, srNum: "missing", assigned: true }, now),
          ).rejects.toMatchObject({ code: "DDT_SR_TAG_NOT_FOUND" });
          await repository.assign(
            scope,
            { tagId: wallet.id, srNum: "钱包-SR", assigned: false },
            now,
          );
          await repository.assign(
            scope,
            { tagId: wallet.id, srNum: "钱包-SR", assigned: false },
            now,
          );
          expect((await repository.lookup(scope, ["钱包-SR"]))["钱包-SR"]).toEqual([smoke]);
          // Independent labels never create or change execution-class/category mappings.
          expect(
            await execute("SELECT * FROM ddt_sr_execution_mappings WHERE project_version_id=?", [
              scope.projectVersionId,
            ]),
          ).toEqual([]);
          const all = await repository.list(scope, { query: "", limit: 1 });
          expect(all.items).toEqual([smoke]);
          expect(all.nextCursor).toBe("smoke");
          expect(
            (await repository.list(scope, { query: "", cursor: all.nextCursor, limit: 1 })).items,
          ).toEqual([wallet]);
          expect(
            (await repository.list(scope, { query: "Wallet", limit: 100, tagIds: [wallet.id] }))
              .items,
          ).toEqual([wallet]);
          const reservation = randomUUID();
          await execute(
            `INSERT INTO project_version_copies(id,source_project_id,source_version_id,source_version_name,target_project_id,target_version_id,target_version_name,request_key,requested_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'failed',?,?)`,
            [
              reservation,
              scope.projectId,
              f.otherVersionId,
              "source",
              scope.projectId,
              scope.projectVersionId,
              "reserved",
              reservation,
              "operator",
              now,
              now,
            ],
          );
          try {
            await expect(
              repository.create(scope, { id: randomUUID(), name: "Blocked" }, now),
            ).rejects.toMatchObject({ code: "VERSION_COPY_TARGET_RESERVED" });
            for (const assigned of [true, false])
              await expect(
                repository.assign(scope, { tagId: smoke.id, srNum: "钱包-SR", assigned }, now),
              ).rejects.toMatchObject({ code: "VERSION_COPY_TARGET_RESERVED" });
          } finally {
            await execute("DELETE FROM project_version_copies WHERE id=?", [reservation]);
          }
        } finally {
          await f.close();
        }
      }, 30000);
    },
  );
}
async function fixture(dialect: "sqlite" | "postgres", upgrade = false) {
  const directory = await mkdtemp(resolve(tmpdir(), "ddt-sr-tags-"));
  const currentMigrations = resolve(
    `packages/db/drizzle/${dialect === "sqlite" ? "sqlite" : "postgresql"}`,
  );
  const migrationFolder = upgrade ? resolve(directory, "previous-migrations") : currentMigrations;
  if (upgrade) {
    await mkdir(migrationFolder);
    const names = (await readdir(currentMigrations))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .slice(0, -1);
    for (const name of names)
      await copyFile(resolve(currentMigrations, name), resolve(migrationFolder, name));
  }
  let sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "db.sqlite"),
          migrationsFolder: migrationFolder,
        })
      : undefined;
  const admin =
    dialect === "postgres"
      ? new Client({ connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL! })
      : undefined;
  const databaseName = `sr_tags_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL ?? "postgres://unused/unused");
  if (admin) {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    url.pathname = `/${databaseName}`;
  }
  let postgres =
    dialect === "postgres"
      ? createPostgresDatabase({
          connectionString: url.toString(),
          migrationsFolder: migrationFolder,
          poolMax: 2,
        })
      : undefined;
  await postgres?.ready;
  const scope = { projectId: DEFAULT_PROJECT_ID, projectVersionId: randomUUID() };
  const otherVersionId = randomUUID();
  const suiteId = randomUUID();
  const untaggedId = randomUUID();
  async function execute(
    sql: string,
    values: (string | number)[] = [],
  ): Promise<Record<string, unknown>[]> {
    if (sqlite) {
      const query = sqlite.client.prepare(sql);
      if (query.reader) return query.all(...values) as Record<string, unknown>[];
      query.run(...values);
      return [];
    }
    let index = 0;
    return (
      await postgres!.pool.query(
        sql.replaceAll("?", () => `$${++index}`),
        values,
      )
    ).rows;
  }
  for (const version of [scope.projectVersionId, otherVersionId])
    await execute(
      "INSERT INTO project_versions(id,project_id,name,normalized_name,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [version, scope.projectId, version, version, now, now],
    );
  await execute(
    "INSERT INTO case_suites(id,project_id,name,version,created_at,updated_at) VALUES (?,?,?,1,?,?)",
    [suiteId, scope.projectId, "mixed-suite", now, now],
  );
  for (const stage of ["stage-one", "stage-two"])
    await execute(
      "INSERT INTO test_stages(id,project_id,project_version_id,name,normalized_name,description,position,created_at,updated_at) VALUES (?,?,?,?,?,'',?,?,?)",
      [
        `${stage}-${suiteId}`,
        scope.projectId,
        scope.projectVersionId,
        stage,
        stage,
        stage === "stage-one" ? 1 : 2,
        now,
        now,
      ],
    );
  for (let index = 0; index < 207; index++) {
    const id = index === 206 ? untaggedId : randomUUID();
    const sr = index === 206 ? "untagged" : "钱包-SR";
    await execute(
      `INSERT INTO ddt_cases(id,project_id,project_version_id,test_stage_id,case_id,case_id_normalized,sr_num,sr_num_normalized,case_kind,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'standard','{}',?,?)`,
      [
        id,
        ...Object.values(scope),
        `${index % 2 ? "stage-one" : "stage-two"}-${suiteId}`,
        `CASE-${index}`,
        `case-${index}`,
        sr,
        sr.toLowerCase(),
        now,
        now,
      ],
    );
    // One labelled case is outside the task and must never be selected.
    if (index !== 205)
      await execute(
        "INSERT INTO case_suite_ddt_items(id,suite_id,ddt_case_id,added_at) VALUES (?,?,?,?)",
        [`member-${String(index).padStart(4, "0")}-${suiteId}`, suiteId, id, now],
      );
  }
  if (upgrade) {
    if (sqlite) {
      sqlite.close();
      sqlite = createSqliteDatabase({
        databasePath: resolve(directory, "db.sqlite"),
        migrationsFolder: currentMigrations,
      });
    } else {
      await postgres!.close();
      postgres = createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder: currentMigrations,
        poolMax: 2,
      });
      await postgres.ready;
    }
  }
  const repository = sqlite
    ? new SqliteDdtSrTagRepository(sqlite)
    : new PostgresDdtSrTagRepository(postgres!);
  return {
    repository,
    scope,
    otherVersionId,
    suiteId,
    untaggedId,
    execute,
    close: async () => {
      await execute("DELETE FROM case_suites WHERE id=?", [suiteId]);
      await execute("DELETE FROM ddt_cases WHERE project_version_id=?", [scope.projectVersionId]);
      for (const version of [scope.projectVersionId, otherVersionId])
        await execute("DELETE FROM project_versions WHERE id=?", [version]);
      sqlite?.close();
      await postgres?.close();
      if (admin) {
        await admin.query(`DROP DATABASE ${databaseName}`);
        await admin.end();
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
