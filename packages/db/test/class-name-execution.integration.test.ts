import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as sqliteSchema from "../src/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CaseCatalogRepository,
  IdentityAccessRepository,
  ProjectStructureRepository,
} from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { SqliteCaseCatalogRepository } from "../src/sqlite-case-catalog";
import { SqliteIdentityAccessRepository } from "../src/sqlite-identity-access";
import { SqliteProjectStructureRepository } from "../src/sqlite-project-structure";
import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresCaseCatalogRepository } from "../src/postgres-platform-repository";
import { PostgresIdentityAccessRepository } from "../src/postgres-identity-access";
import { PostgresProjectStructureRepository } from "../src/postgres-project-structure";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const recordedAt = "2026-10-16T00:00:00.000Z";
const scope = {
  projectId: "lookup-project",
  projectVersionId: "lookup-version",
  testStageId: "lookup-stage",
};
const className = "com.example.CheckoutTest";
type SqlValue = string | boolean | number;
type Harness = {
  catalog: CaseCatalogRepository;
  identities: IdentityAccessRepository;
  structures: ProjectStructureRepository;
  execute(statement: string, values: SqlValue[]): Promise<void>;
  explainClassLookup?(): Promise<string[]>;
  dispose(): Promise<void>;
};

for (const adapter of ["sqlite", "postgres"] as const) {
  describe.skipIf(adapter === "postgres" && !connectionString)(
    `${adapter} execution class lookup`,
    () => {
      let harness: Harness;
      beforeAll(async () => {
        harness = await createHarness(adapter);
        await seedClasses(harness);
      });
      afterAll(async () => {
        await harness?.dispose();
      });

      it("matches the exact class in the requested project, version and stage without reading metadata", async () => {
        expect(await harness.catalog.findCaseDefinitionIdsByClassName(scope, className)).toEqual([
          "canonical",
        ]);
        expect(
          await harness.catalog.findCaseDefinitionIdsByClassName(
            { ...scope, testStageId: "other-stage" },
            className,
          ),
        ).toEqual(["other-stage-case"]);
        expect(
          await harness.catalog.findCaseDefinitionIdsByClassName(
            { ...scope, projectVersionId: "other-version", testStageId: "version-stage" },
            className,
          ),
        ).toEqual(["other-version-case"]);
        expect(
          await harness.catalog.findCaseDefinitionIdsByClassName(
            {
              projectId: "other-project",
              projectVersionId: "project-version",
              testStageId: "project-stage",
            },
            className,
          ),
        ).toEqual(["other-project-case"]);
      });

      it.each([
        "CheckoutTest",
        "com.example.Checkout%",
        "com.example.CheckoutTes_",
        "com.example.checkouttest",
      ])("does not approximate class identity: %s", async (query) => {
        expect(await harness.catalog.findCaseDefinitionIdsByClassName(scope, query)).toEqual([]);
      });

      it("bounds duplicate matches to two IDs so callers can reject ambiguity", async () => {
        const ids = await harness.catalog.findCaseDefinitionIdsByClassName(
          scope,
          "com.example.Duplicate",
        );
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
        expect(ids.every((id) => id.startsWith("duplicate-"))).toBe(true);
      });

      if (adapter === "sqlite")
        it("uses class equality in its index search instead of scanning the ordered stage", async () => {
          expect((await harness.explainClassLookup!()).join("\n")).toContain(
            "project_id=? AND project_version_id=? AND test_stage_id=? AND class_name=?",
          );
        });

      it("keeps a disabled definition visible to the normal execution preflight", async () => {
        expect(
          await harness.catalog.findCaseDefinitionIdsByClassName(scope, "com.example.Disabled"),
        ).toEqual(["disabled"]);
      });
    },
  );
}

async function seedClasses(harness: Harness): Promise<void> {
  for (const projectId of [scope.projectId, "other-project"]) {
    await harness.identities.createProject({
      id: projectId,
      name: projectId,
      slug: projectId,
      createdAt: recordedAt,
    });
  }
  const scopes = [
    scope,
    { ...scope, testStageId: "other-stage" },
    { ...scope, projectVersionId: "other-version", testStageId: "version-stage" },
    {
      projectId: "other-project",
      projectVersionId: "project-version",
      testStageId: "project-stage",
    },
  ];
  const createdVersions = new Set<string>();
  for (const [position, candidate] of scopes.entries()) {
    if (!createdVersions.has(candidate.projectVersionId)) {
      await harness.structures.createVersion({
        id: candidate.projectVersionId,
        projectId: candidate.projectId,
        name: candidate.projectVersionId,
        normalizedName: candidate.projectVersionId,
        recordedAt,
      });
      createdVersions.add(candidate.projectVersionId);
    }
    await harness.structures.createStage({
      id: candidate.testStageId,
      projectId: candidate.projectId,
      projectVersionId: candidate.projectVersionId,
      name: `Stage ${position}`,
      normalizedName: `stage ${position}`,
      description: "",
      recordedAt,
    });
  }
  const entries = [
    { id: "canonical", scope },
    { id: "other-stage-case", scope: scopes[1]! },
    { id: "other-version-case", scope: scopes[2]! },
    { id: "other-project-case", scope: scopes[3]! },
    { id: "archived", scope, archived: true },
    { id: "inactive-source", scope, lifecycleStatus: "archived" },
    { id: "failed-source", scope, status: "failed" },
    { id: "foreign-source", scope, sourceProjectId: "other-project" },
    { id: "disabled", scope, enabled: false, className: "com.example.Disabled" },
    ...["a", "b", "c"].map((suffix) => ({
      id: `duplicate-${suffix}`,
      scope,
      className: "com.example.Duplicate",
    })),
  ];
  for (const entry of entries) {
    await harness.execute(
      `INSERT INTO case_sources
      (id, project_id, project_version_id, test_stage_id, display_name, original_file_name, object_key, sha256, size_bytes, class_count, method_count, status, lifecycle_status, warnings_json, inspection_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, '[]', 'invalid-metadata', ?, ?)`,
      [
        entry.id,
        "sourceProjectId" in entry ? entry.sourceProjectId! : entry.scope.projectId,
        entry.scope.projectVersionId,
        entry.scope.testStageId,
        entry.id,
        `${entry.id}.jar`,
        `jars/${entry.id}`,
        entry.id,
        "status" in entry ? entry.status! : "ready",
        "lifecycleStatus" in entry ? entry.lifecycleStatus! : "active",
        recordedAt,
        recordedAt,
      ],
    );
    await harness.execute(
      `INSERT INTO case_definitions
      (id, source_id, project_id, project_version_id, test_stage_id, class_name, package_name, display_name, enabled, archived, groups_json, parameters_json, current_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'com.example', 'Unrelated display name', ?, ?, '[]', 'invalid-metadata', 1, ?, ?)`,
      [
        entry.id,
        entry.id,
        entry.scope.projectId,
        entry.scope.projectVersionId,
        entry.scope.testStageId,
        "className" in entry ? entry.className! : className,
        "enabled" in entry ? entry.enabled! : true,
        "archived" in entry ? entry.archived! : false,
        recordedAt,
        recordedAt,
      ],
    );
  }
}

async function createHarness(adapter: "sqlite" | "postgres"): Promise<Harness> {
  if (adapter === "sqlite") {
    const directory = await mkdtemp(resolve(tmpdir(), "autoforge-class-lookup-"));
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "platform.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    return {
      catalog: new SqliteCaseCatalogRepository(handle),
      identities: new SqliteIdentityAccessRepository(handle),
      structures: new SqliteProjectStructureRepository(handle),
      async explainClassLookup() {
        const queries: Array<{ sql: string; parameters: unknown[] }> = [];
        const logged = new SqliteCaseCatalogRepository({
          ...handle,
          db: drizzle(handle.client, {
            schema: sqliteSchema,
            logger: {
              logQuery(sql, parameters) {
                queries.push({ sql, parameters });
              },
            },
          }),
        });
        await logged.findCaseDefinitionIdsByClassName(scope, className);
        const captured = queries.at(-1);
        if (!captured) throw new Error("Class lookup did not execute a SQL query.");
        const rows = handle.client
          .prepare(`EXPLAIN QUERY PLAN ${captured.sql}`)
          .all(...captured.parameters) as Array<{ detail: string }>;
        return rows.map((row) => row.detail);
      },
      async execute(statement, values) {
        handle.client
          .prepare(statement)
          .run(...values.map((value) => (typeof value === "boolean" ? Number(value) : value)));
      },
      async dispose() {
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
  const administration = new Pool({ connectionString, max: 1 });
  const schema = `class_lookup_${randomUUID().replaceAll("-", "")}`;
  await administration.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const handle = createPostgresDatabase({
    connectionString: url.toString(),
    migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
    poolMax: 2,
  });
  await handle.ready;
  return {
    catalog: new PostgresCaseCatalogRepository(handle),
    identities: new PostgresIdentityAccessRepository(handle),
    structures: new PostgresProjectStructureRepository(handle),
    async execute(statement, values) {
      let parameter = 0;
      await handle.pool.query(
        statement.replaceAll("?", () => `$${++parameter}`),
        values,
      );
    },
    async dispose() {
      await handle.close();
      try {
        await administration.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await administration.end();
      }
    },
  };
}
