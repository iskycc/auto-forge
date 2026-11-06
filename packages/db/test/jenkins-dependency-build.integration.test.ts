import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { versionCopyTargetHasContentSql } from "../src/version-copy-target";
import { runSqliteMigrations } from "../src/migrations";
import { runPostgresMigrations } from "../src/postgres-database";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteJenkinsDependencyRepository } from "../src/sqlite-jenkins-dependency";
import { PostgresJenkinsDependencyRepository } from "../src/postgres-jenkins-dependency";

for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} version Jenkins configuration`,
    () => {
      it("persists config, scopes versions, atomically admits a single build, and conditionally updates state", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "jenkins-dependency-db-"));
        const sqlite =
          dialect === "sqlite"
            ? createSqliteDatabase({
                databasePath: resolve(directory, "db.sqlite"),
                migrationsFolder: resolve("packages/db/drizzle/sqlite"),
              })
            : undefined;
        const postgres =
          dialect === "postgres"
            ? createPostgresDatabase({
                connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
                migrationsFolder: resolve("packages/db/drizzle/postgresql"),
              })
            : undefined;
        await postgres?.ready;
        const repository = sqlite
          ? new SqliteJenkinsDependencyRepository(sqlite)
          : new PostgresJenkinsDependencyRepository(postgres!);
        const execute = async (statement: string, values: string[] = []) => {
          if (sqlite) sqlite.client.prepare(statement).run(...values);
          else {
            let position = 0;
            await postgres!.pool.query(
              statement.replaceAll("?", () => `$${++position}`),
              values,
            );
          }
        };
        const versionId = randomUUID();
        const projectId = "00000000-0000-7000-8000-000000000001";
        // The default project is installed by migrations in both dialects.
        try {
          await execute(
            "INSERT INTO project_versions(id,project_id,name,normalized_name,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?)",
            [
              versionId,
              projectId,
              versionId,
              versionId,
              "2026-11-06T10:00:00Z",
              "2026-11-06T10:00:00Z",
            ],
          );
          expect(await repository.versionStatus("another-project", versionId)).toBeNull();
          const config = {
            projectId,
            versionId,
            expectedRevision: 0,
            connectionCiphertext: "encrypted-credentials",
            updatedAt: "2026-11-06T10:00:00Z",
          };
          expect(await repository.save(config)).toBe(true);
          const contentStatement = `SELECT CASE WHEN (${versionCopyTargetHasContentSql(dialect)}) THEN 1 ELSE 0 END AS has_content FROM project_versions v WHERE v.id=?`;
          const contentRows = sqlite
            ? (sqlite.client.prepare(contentStatement).all(versionId) as Array<{
                has_content: number;
              }>)
            : (
                await postgres!.pool.query<{ has_content: number }>(
                  contentStatement.replaceAll("?", "$1"),
                  [versionId],
                )
              ).rows;
          expect(Number(contentRows[0]?.has_content)).toBe(1);

          expect(await repository.save(config)).toBe(false);
          const build = {
            id: randomUUID(),
            status: "submitting" as const,
            jobUrl: "https://jenkins.test/job/deps/",
            triggeredBy: "operator",
            triggeredAt: "2026-11-06T10:00:00Z",
          };
          const claims = await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
              repository.claim({
                versionId,
                expectedRevision: 1,
                expectedBuildRevision: 0,
                build: { ...build, id: `${build.id}-${index}` },
              }),
            ),
          );
          expect(claims.filter(Boolean)).toHaveLength(1);
          expect(await repository.save({ ...config, expectedRevision: 1 })).toBe(false);
          expect(
            await repository.updateBuild(versionId, 0, { ...build, status: "succeeded" }),
          ).toBe(false);
          expect(
            await repository.updateBuild(versionId, 1, {
              ...build,
              status: "queued",
              queueUrl: "https://jenkins.test/queue/item/7/",
            }),
          ).toBe(true);
          const reopened = sqlite
            ? new SqliteJenkinsDependencyRepository(sqlite)
            : new PostgresJenkinsDependencyRepository(postgres!);
          expect((await reopened.read(versionId))?.build?.queueUrl).toContain("/7/");
          expect(await repository.updateBuild(versionId, 2, { ...build, status: "failed" })).toBe(
            true,
          );
          expect(await repository.save({ ...config, expectedRevision: 1 })).toBe(true);
          await execute("UPDATE project_versions SET status='archived' WHERE id=?", [versionId]);
          expect(await repository.versionStatus(projectId, versionId)).toBe("archived");
          expect(
            await repository.claim({
              versionId,
              expectedRevision: 2,
              expectedBuildRevision: 3,
              build,
            }),
          ).toBe(false);
        } finally {
          await execute("DELETE FROM version_jenkins_dependencies WHERE version_id=?", [versionId]);
          await execute("DELETE FROM project_versions WHERE id=?", [versionId]);
          sqlite?.close();
          await postgres?.close();
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  );

describe("dependency build migration recovery", () => {
  it("upgrades the preceding SQLite schema atomically and recovers after a failed migration", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "jenkins-migration-"));
    const previous = resolve(directory, "previous");
    const broken = resolve(directory, "broken");
    await mkdir(previous);
    await mkdir(broken);
    const folder = resolve("packages/db/drizzle/sqlite");
    const latest = "0097_jenkins_dependency_builds.sql";
    const files = (await readdir(folder)).filter((file) => file.endsWith(".sql"));
    for (const file of files)
      if (file !== latest) {
        const content = await readFile(resolve(folder, file), "utf8");
        await writeFile(resolve(previous, file), content);
        await writeFile(resolve(broken, file), content);
      }
    await writeFile(
      resolve(broken, latest),
      (await readFile(resolve(folder, latest), "utf8")) + "\nINVALID SQL;",
    );
    const handle = createSqliteDatabase({
      databasePath: resolve(directory, "db.sqlite"),
      migrationsFolder: previous,
    });
    try {
      expect(() => runSqliteMigrations(handle.client, broken)).toThrow();
      expect(
        handle.client
          .prepare("SELECT name FROM sqlite_master WHERE name='version_jenkins_dependencies'")
          .get(),
      ).toBeUndefined();
      runSqliteMigrations(handle.client, folder);
      expect(
        await new SqliteJenkinsDependencyRepository(handle).read("missing-version"),
      ).toBeNull();
      expect(
        handle.client.prepare("SELECT name FROM _autoforge_migrations WHERE name=?").get(latest),
      ).toBeTruthy();
    } finally {
      handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.skipIf(!process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    "upgrades the preceding PostgreSQL schema and rolls back partial DDL on failure",
    async () => {
      const admin = createPostgresDatabase({
        connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
        migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      });
      await admin.ready;
      const databaseName = `jenkins_upgrade_${randomUUID().replaceAll("-", "")}`;
      const directory = await mkdtemp(resolve(tmpdir(), "jenkins-pg-migration-"));
      const previous = resolve(directory, "previous");
      const broken = resolve(directory, "broken");
      await mkdir(previous);
      await mkdir(broken);
      const folder = resolve("packages/db/drizzle/postgresql");
      const latest = "0096_jenkins_dependency_builds.sql";
      let upgraded: ReturnType<typeof createPostgresDatabase> | undefined;
      try {
        await admin.pool.query(`CREATE DATABASE ${databaseName}`);
        for (const file of (await readdir(folder)).filter(
          (file) => file.endsWith(".sql") && file !== latest,
        )) {
          const content = await readFile(resolve(folder, file), "utf8");
          await writeFile(resolve(previous, file), content);
          await writeFile(resolve(broken, file), content);
        }
        await writeFile(
          resolve(broken, latest),
          (await readFile(resolve(folder, latest), "utf8")) + "\nINVALID SQL;",
        );
        const url = new URL(process.env.AUTOFORGE_TEST_POSTGRES_URL!);
        url.pathname = databaseName;
        upgraded = createPostgresDatabase({
          connectionString: url.toString(),
          migrationsFolder: previous,
        });
        await upgraded.ready;
        await expect(runPostgresMigrations(upgraded.pool, broken)).rejects.toThrow();
        expect(
          (
            await upgraded.pool.query(
              "SELECT to_regclass('version_jenkins_dependencies') AS relation",
            )
          ).rows[0]?.relation,
        ).toBeNull();
        await runPostgresMigrations(upgraded.pool, folder);
        expect(
          await new PostgresJenkinsDependencyRepository(upgraded).read("missing-version"),
        ).toBeNull();
      } finally {
        await upgraded?.close();
        await admin.pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        await admin.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30000,
  );
});
