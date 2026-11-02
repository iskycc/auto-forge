import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, copyFileSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresDatabase } from "../src/postgres-database";
import { PostgresStorageMonitoringRepository } from "../src/postgres-storage-monitoring";
import { readPostgresStorageCapacity } from "../src/postgres-storage-capacity";
const url = process.env.AUTOFORGE_TEST_POSTGRES_URL;
const exporterDataDirectory = process.env.AUTOFORGE_TEST_NODE_EXPORTER_DATA_DIR;
const migrations = resolve("packages/db/drizzle/postgresql");
describe.skipIf(!url)("shared PostgreSQL monitoring configuration", () => {
  it("upgrades from the previous schema, rolls back a failed migration, persists across nodes and rejects stale writes", async () => {
    const schema = `monitor_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const directory = mkdtempSync(join(tmpdir(), "af-monitoring-upgrade-"));
    for (const file of readdirSync(migrations))
      if (file.endsWith(".sql") && file !== "0091_storage_monitoring.sql")
        copyFileSync(join(migrations, file), join(directory, file));
    let database = createPostgresDatabase({
      connectionString: scoped.toString(),
      migrationsFolder: directory,
      poolMax: 1,
    });
    try {
      await database.ready;
      expect(
        (await database.pool.query("SELECT to_regclass('storage_monitoring_settings') AS name"))
          .rows[0]!.name,
      ).toBeNull();
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(join(migrations, "0091_storage_monitoring.sql"), "utf8"));
        await expect(client.query("SELECT 1/0")).rejects.toMatchObject({ code: "22012" });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(
        (await database.pool.query("SELECT to_regclass('storage_monitoring_settings') AS name"))
          .rows[0]!.name,
      ).toBeNull();
      await database.close();
      database = createPostgresDatabase({
        connectionString: scoped.toString(),
        migrationsFolder: migrations,
        poolMax: 1,
      });
      await database.ready;
      const first = new PostgresStorageMonitoringRepository(database),
        second = new PostgresStorageMonitoringRepository(database);
      const target = { kind: "primary" as const },
        source = { host: "db-metrics", port: 19100, tls: false, mountpoint: "/pgdata" };
      expect(await first.read(target)).toEqual({ target, source: null, revision: 1 });
      const writes = await Promise.allSettled([
        first.save({ target, source, revision: 1 }, "2026-11-02T00:00:00Z"),
        second.save({ target, source: null, revision: 1 }, "2026-11-02T00:00:00Z"),
      ]);
      expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const current = await second.read(target);
      expect(current.revision).toBe(2);
      await expect(
        first.save({ target, source, revision: 1 }, "2026-11-02T00:00:01Z"),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
      await second.save({ target, source, revision: 2 }, "2026-11-02T00:00:01Z");
      expect((await first.read(target)).source).toEqual(source);
      await expect(first.read({ kind: "logs", databaseId: randomUUID() })).rejects.toMatchObject({
        code: "LOG_DATABASE_NOT_FOUND",
      });
      await database.close();
      database = createPostgresDatabase({
        connectionString: scoped.toString(),
        migrationsFolder: migrations,
        poolMax: 1,
      });
      await database.ready;
      expect(await new PostgresStorageMonitoringRepository(database).read(target)).toMatchObject({
        source,
        revision: 3,
      });
    } finally {
      await database.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
it.skipIf(!process.env.AUTOFORGE_TEST_NODE_EXPORTER_PORT || !exporterDataDirectory)(
  "reads the actual read-only Node Exporter volume instead of the Web filesystem",
  async () => {
    const capacity = await readPostgresStorageCapacity(
      {
        host: "127.0.0.1",
        port: Number(process.env.AUTOFORGE_TEST_NODE_EXPORTER_PORT),
        tls: false,
        mountpoint: "/pgdata",
      },
      new Date(),
    );
    const filesystem = statfsSync(exporterDataDirectory!);
    expect(capacity.status).toBe("available");
    expect(capacity.capacityBytes).toBe(filesystem.bsize * filesystem.blocks);
    expect(Math.abs(capacity.availableBytes! - filesystem.bsize * filesystem.bavail)).toBeLessThan(
      64 * 1024 * 1024,
    );
    expect(capacity.capacityBytes).not.toBe(
      statfsSync("/opt/auto-forge").bsize * statfsSync("/opt/auto-forge").blocks,
    );
  },
);
