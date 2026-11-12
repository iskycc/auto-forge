import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import { PostgresRunnerRepository } from "../src/postgres-platform-repository";
import { SqliteRunnerInstallationProfileRepository } from "../src/sqlite-runner-installation-profile";
import { PostgresRunnerInstallationProfileRepository } from "../src/postgres-runner-installation-profile";

const postgresUrl = process.env.AUTOFORGE_TEST_POSTGRES_URL;
async function fixture(dialect: "sqlite" | "postgres") {
  const directory = await mkdtemp(resolve(tmpdir(), "rejected-agent-"));
  const admin =
    dialect === "postgres" ? new Pool({ connectionString: postgresUrl!, max: 1 }) : undefined;
  const schema = `rejected_${randomUUID().replaceAll("-", "")}`;
  const url = postgresUrl ? new URL(postgresUrl) : undefined;
  if (admin) {
    await admin.query(`CREATE SCHEMA ${schema}`);
    url!.searchParams.set("options", `-c search_path=${schema}`);
  }
  const sqlite =
    dialect === "sqlite"
      ? createSqliteDatabase({
          databasePath: resolve(directory, "platform.db"),
          migrationsFolder: resolve("packages/db/drizzle/sqlite"),
        })
      : undefined;
  const pg =
    dialect === "postgres"
      ? createPostgresDatabase({
          connectionString: url!.toString(),
          migrationsFolder: resolve("packages/db/drizzle/postgresql"),
          poolMax: 2,
        })
      : undefined;
  await pg?.ready;
  return {
    runners: sqlite ? new SqliteRunnerRepository(sqlite) : new PostgresRunnerRepository(pg!),
    profiles: sqlite
      ? new SqliteRunnerInstallationProfileRepository(sqlite)
      : new PostgresRunnerInstallationProfileRepository(pg!),
    async close() {
      sqlite?.close();
      await pg?.close();
      if (admin) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
for (const dialect of ["sqlite", "postgres"] as const)
  describe.skipIf(dialect === "postgres" && !postgresUrl)(
    `${dialect} deleted Runner contacts`,
    () => {
      it("records only known purged nodes, bounds repeated writes, pages and clears only successful uninstall", async () => {
        const f = await fixture(dialect);
        const at = (minute: number) =>
          new Date(Date.parse("2026-11-12T00:00:00.000Z") + minute * 60_000).toISOString();
        const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
        try {
          for (const id of ids)
            await f.runners.register({
              id,
              bootstrapTokenHash: randomUUID(),
              credentialHash: `credential:${id}`,
              name: `Deleted ${id}`,
              os: "linux",
              architecture: "amd64",
              agentVersion: "1.22.11",
              protocolVersion: 1,
              labels: ["original"],
              capabilities: [],
              maxConcurrency: 1,
              terminalEnabled: false,
              recordedAt: at(0),
            });
          const contact = (runnerId: string, minute: number) =>
            f.runners.recordRejectedContact({
              runnerId,
              recordedAt: at(minute),
              previousWindowBefore: at(minute - 1),
            });
          await contact(ids[0]!, 1);
          await contact(randomUUID(), 1);
          await f.runners.deregister({ runnerId: ids[0]!, deregisteredAt: at(1) });
          await contact(ids[0]!, 2);
          expect((await f.runners.listRejectedContacts({ limit: 10 })).items).toEqual([]);
          for (const id of ids) {
            await f.runners.deregister({ runnerId: id, deregisteredAt: at(1) });
            await f.runners.purge({ runnerId: id, purgedAt: at(2) });
            await contact(id, 3);
          }
          const first = await f.runners.listRejectedContacts({ limit: 2 });
          expect(first.items.map((row) => row.runnerId)).toEqual(ids.slice(0, 2));
          expect(first.nextCursor).toBe(ids[1]);
          expect(
            (
              await f.runners.listRejectedContacts({ limit: 2, afterId: first.nextCursor! })
            ).items.map((row) => row.runnerId),
          ).toEqual(ids.slice(2));
          await Promise.all(Array.from({ length: 20 }, () => contact(ids[0]!, 3.5)));
          expect((await f.runners.listRejectedContacts({ limit: 10 })).items[0]).toMatchObject({
            firstRejectedAt: at(3),
            lastRejectedAt: at(3),
          });
          await contact(ids[0]!, 4);
          const record = (await f.runners.listRejectedContacts({ limit: 10 })).items[0]!;
          expect(record).toMatchObject({
            lastRejectedAt: at(4),
            firstRejectedAt: at(3),
            name: `Deleted ${ids[0]}`,
          });
          expect(Object.keys(record).sort()).toEqual(
            [
              "runnerId",
              "name",
              "agentVersion",
              "purgedAt",
              "firstRejectedAt",
              "lastRejectedAt",
            ].sort(),
          );
          expect(await f.runners.findByCredentialHash(`credential:${ids[0]}`, at(4))).toBeNull();
          expect(await f.runners.list(at(4), 100)).toEqual([]);
          expect(await f.runners.get(ids[0]!, at(4))).toMatchObject({
            purgedAt: at(2),
            lastSeenAt: at(0),
            state: "disabled",
          });
          await f.profiles.finalizeUninstall({ runnerId: ids[0]!, purgedAt: at(5) });
          await contact(ids[0]!, 4.9);
          expect(
            (await f.runners.listRejectedContacts({ limit: 10 })).items.map((row) => row.runnerId),
          ).not.toContain(ids[0]);
          // A genuinely later rejected request reopens diagnostics instead of hiding a failed cleanup.
          await contact(ids[0]!, 6);
          expect((await f.runners.listRejectedContacts({ limit: 10 })).items[0]).toMatchObject({
            firstRejectedAt: at(6),
            lastRejectedAt: at(6),
          });
        } finally {
          await f.close();
        }
      });
    },
  );
