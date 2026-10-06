import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID, defaultCaseSuiteExecutionPolicy } from "@autoforge/domain";
import type { CaseSuiteRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteCaseSuiteRepository } from "../src/sqlite-case-suite";
import { PostgresCaseSuiteRepository } from "../src/postgres-platform-repository";

const timestamp = "2026-10-06T00:00:00.000Z";
const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
type Dialect = "sqlite" | "postgresql";
type Fixture = {
  suites: CaseSuiteRepository;
  execute(statement: string, parameters?: string[]): Promise<void>;
  rows(statement: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
};

async function fixture(dialect: Dialect, migrationsFolder?: string): Promise<Fixture> {
  const folder = migrationsFolder ?? resolve(import.meta.dirname, `../drizzle/${dialect}`);
  if (dialect === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "suite-pins-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "test.sqlite"),
      migrationsFolder: folder,
    });
    return {
      suites: new SqliteCaseSuiteRepository(handle),
      execute: async (statement, parameters = []) => {
        handle.client.prepare(statement).run(...parameters);
      },
      rows: async (statement) =>
        handle.client.prepare(statement).all() as Record<string, unknown>[],
      close: async () => {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const schema = `suite_pins_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: postgresUrl!, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(postgresUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: folder,
    // Keep the explicit migration transaction on one connection.
    poolMax: 1,
  });
  await handle.ready;
  return {
    suites: new PostgresCaseSuiteRepository(handle),
    execute: async (statement, parameters = []) => {
      let index = 0;
      await handle.pool.query(
        statement.replaceAll("?", () => `$${++index}`),
        parameters,
      );
    },
    rows: async (statement) => (await handle.pool.query<Record<string, unknown>>(statement)).rows,
    close: async () => {
      await handle.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

async function seed(f: Fixture, count = 1): Promise<void> {
  for (const userId of ["user-a", "user-b"]) {
    await f.execute(
      `INSERT INTO users (id, username, normalized_username, display_name, source, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'local', 'active', ?, ?)`,
      [userId, userId, userId, userId, timestamp, timestamp],
    );
  }
  const policy = { ...defaultCaseSuiteExecutionPolicy, projectVersionId: "version" };
  for (let index = 0; index < count; index++) {
    await f.suites.create({
      id: `suite-${index}`,
      name: `任务 ${index}`,
      policy,
      createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
    });
  }
}

for (const dialect of ["sqlite", "postgresql"] as const) {
  describe.skipIf(dialect === "postgresql" && !postgresUrl)(`${dialect} personal task pins`, () => {
    it("keeps an older pinned task inside a bounded list while preserving other users' default ordering", async () => {
      const f = await fixture(dialect);
      try {
        await seed(f, 205);
        const input = { userId: "user-a", suiteId: "suite-0", pinned: true, createdAt: timestamp };
        await f.suites.setPinned(input);
        await f.suites.setPinned(input);
        const page = await f.suites.list(200, [DEFAULT_PROJECT_ID], "version", undefined, "user-a");
        expect(page).toHaveLength(200);
        expect(page[0]!.id).toBe("suite-0");
        expect(page[1]!.id).toBe("suite-204");
        expect(
          await f.suites.listPinnedSuiteIds(
            "user-a",
            page.map((suite) => suite.id),
          ),
        ).toEqual(["suite-0"]);
        expect(await f.rows("SELECT * FROM case_suite_pins")).toHaveLength(1);
        const other = await f.suites.list(
          200,
          [DEFAULT_PROJECT_ID],
          "version",
          undefined,
          "user-b",
        );
        expect(other[0]!.id).toBe("suite-204");
        expect(other.some((suite) => suite.id === "suite-0")).toBe(false);
        expect(await f.suites.listPinnedSuiteIds("user-b", ["suite-0"])).toEqual([]);
        expect((await f.suites.list(200))[0]!.id).toBe("suite-204");
      } finally {
        await f.close();
      }
    });

    it("scopes pin priority to authorized projects and the selected version", async () => {
      const f = await fixture(dialect);
      try {
        await seed(f);
        await f.suites.create({
          id: "other-version",
          name: "Other version",
          policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId: "other" },
          createdAt: timestamp,
        });
        await f.suites.create({
          id: "other-project",
          projectId: "other-project",
          name: "Other project",
          policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId: "version" },
          createdAt: timestamp,
        });
        for (const suiteId of ["other-version", "other-project"])
          await f.suites.setPinned({
            userId: "user-a",
            suiteId,
            pinned: true,
            createdAt: timestamp,
          });
        const page = await f.suites.list(200, [DEFAULT_PROJECT_ID], "version", undefined, "user-a");
        expect(page.map((suite) => suite.id)).toEqual(["suite-0"]);
        expect(
          await f.suites.listPinnedSuiteIds(
            "user-a",
            page.map((suite) => suite.id),
          ),
        ).toEqual([]);
        expect(await f.suites.list(200, [], "version", undefined, "user-a")).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it("unpins idempotently without changing task revision, version or execution configuration", async () => {
      const f = await fixture(dialect);
      try {
        await seed(f);
        const before = await f.suites.getSummary("suite-0");
        const pin = { userId: "user-a", suiteId: "suite-0", createdAt: timestamp };
        await f.suites.setPinned({ ...pin, pinned: true });
        await f.suites.setPinned({ ...pin, pinned: false });
        await f.suites.setPinned({ ...pin, pinned: false });
        expect(await f.suites.getSummary("suite-0")).toEqual(before);
        expect(await f.suites.listPinnedSuiteIds("user-a", ["suite-0"])).toEqual([]);
        expect(await f.rows("SELECT * FROM case_suite_pins")).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it("upgrades the previous schema without rewriting tasks and rolls back failed pin DDL", async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "suite-pins-upgrade-"));
      const folder = resolve(import.meta.dirname, `../drizzle/${dialect}`);
      const migration =
        dialect === "sqlite" ? "0075_case_suite_pins.sql" : "0073_case_suite_pins.sql";
      for (const name of (await readdir(folder)).filter(
        (name) => name.endsWith(".sql") && name < migration,
      ))
        await writeFile(resolve(directory, name), await readFile(resolve(folder, name)));
      const f = await fixture(dialect, directory);
      try {
        await seed(f);
        const before = await f.rows("SELECT * FROM case_suites");
        const statements = (await readFile(resolve(folder, migration), "utf8"))
          .split(";")
          .map((sql) => sql.trim())
          .filter(Boolean);
        await f.execute("BEGIN");
        for (const statement of statements) await f.execute(statement);
        await expect(f.rows("SELECT * FROM missing_pin_migration_table")).rejects.toThrow();
        await f.execute("ROLLBACK");
        await expect(f.rows("SELECT * FROM case_suite_pins")).rejects.toThrow();
        expect(await f.rows("SELECT * FROM case_suites")).toEqual(before);
        await f.execute("BEGIN");
        for (const statement of statements) await f.execute(statement);
        await f.execute("COMMIT");
        expect(await f.rows("SELECT * FROM case_suite_pins")).toEqual([]);
        expect(await f.rows("SELECT * FROM case_suites")).toEqual(before);
        await f.suites.setPinned({
          userId: "user-a",
          suiteId: "suite-0",
          pinned: true,
          createdAt: timestamp,
        });
        expect(await f.suites.listPinnedSuiteIds("user-a", ["suite-0"])).toEqual(["suite-0"]);
      } finally {
        await f.close();
        await rm(directory, { recursive: true, force: true });
      }
    }, 15_000);
  });
}
