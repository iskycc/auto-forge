import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqliteRunnerRepository } from "../src/sqlite-runner";
import { PostgresRunnerRepository } from "../src/postgres-platform-repository";
import { SqliteRunnerInstallationProfileRepository } from "../src/sqlite-runner-installation-profile";
import { PostgresRunnerInstallationProfileRepository } from "../src/postgres-runner-installation-profile";

for (const dialect of ["sqlite", "postgresql"] as const)
  describe.skipIf(dialect === "postgresql" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${dialect} Agent uninstall completion`,
    () => {
      it("atomically removes saved SSH credentials and tombstones only a deregistered Runner; failures remain retryable", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "runner-uninstall-"));
        const sqlite =
          dialect === "sqlite"
            ? createSqliteDatabase({
                databasePath: resolve(directory, "platform.db"),
                migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
              })
            : undefined;
        const postgres =
          dialect === "postgresql"
            ? createPostgresDatabase({
                connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
                migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
              })
            : undefined;
        if (postgres) await postgres.ready;
        const runners = sqlite
          ? new SqliteRunnerRepository(sqlite)
          : new PostgresRunnerRepository(postgres!);
        const profiles = sqlite
          ? new SqliteRunnerInstallationProfileRepository(sqlite)
          : new PostgresRunnerInstallationProfileRepository(postgres!);
        const execute = async (sql: string) => {
          if (sqlite) sqlite.client.exec(sql);
          else await postgres!.pool.query(sql);
        };
        const id = randomUUID();
        const profileId = randomUUID();
        const trigger = `uninstall_${id.replaceAll("-", "")}`;
        const now = "2026-10-28T00:00:00.000Z";
        let triggerCreated = false;
        const dropTrigger = () =>
          execute(
            sqlite
              ? `DROP TRIGGER IF EXISTS ${trigger}`
              : `DROP TRIGGER IF EXISTS ${trigger} ON runner_installation_profiles; DROP FUNCTION IF EXISTS ${trigger}();`,
          );
        try {
          await runners.register({
            id,
            bootstrapTokenHash: randomUUID(),
            credentialHash: randomUUID(),
            name: `Uninstall ${id}`,
            os: "linux",
            architecture: "amd64",
            agentVersion: "1.21.1",
            protocolVersion: 1,
            labels: ["preserve-until-commit"],
            capabilities: [],
            maxConcurrency: 1,
            terminalEnabled: false,
            recordedAt: now,
          });
          await profiles.upsert({
            id: profileId,
            runnerId: id,
            runnerName: `Uninstall ${id}`,
            connectionEncrypted: "encrypted-ssh-secret",
            expectedHostKeySha256: `SHA256:${"A".repeat(43)}`,
            installationMode: "auto",
            runAsRoot: false,
            createdAt: now,
            updatedAt: now,
          });
          await expect(
            profiles.finalizeUninstall({ runnerId: id, purgedAt: now }),
          ).rejects.toMatchObject({ code: "RUNNER_NOT_DELETABLE" });
          await expect(profiles.get(profileId)).resolves.toMatchObject({
            connectionEncrypted: "encrypted-ssh-secret",
          });
          await runners.deregister({ runnerId: id, deregisteredAt: now });
          await execute(
            sqlite
              ? `CREATE TRIGGER ${trigger} BEFORE DELETE ON runner_installation_profiles WHEN OLD.id = '${profileId}' BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;`
              : `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cleanup failure'; END $$; CREATE TRIGGER ${trigger} BEFORE DELETE ON runner_installation_profiles FOR EACH ROW WHEN (OLD.id = '${profileId}') EXECUTE FUNCTION ${trigger}();`,
          );
          triggerCreated = true;
          await expect(
            profiles.finalizeUninstall({ runnerId: id, purgedAt: now }),
          ).rejects.toMatchObject(
            postgres
              ? {
                  cause: expect.objectContaining({
                    message: expect.stringContaining("injected cleanup failure"),
                  }),
                }
              : { message: expect.stringContaining("injected cleanup failure") },
          );
          expect((await runners.get(id, now))?.purgedAt).toBeUndefined();
          await expect(profiles.get(profileId)).resolves.toMatchObject({
            connectionEncrypted: "encrypted-ssh-secret",
          });
          await dropTrigger();
          triggerCreated = false;
          await profiles.finalizeUninstall({ runnerId: id, purgedAt: now });
          expect((await runners.get(id, now))?.purgedAt).toBe(now);
          expect((await runners.list(now, 500)).some((r) => r.id === id)).toBe(false);
          await expect(profiles.findByRunnerId(id)).resolves.toBeNull();
          await expect(
            profiles.finalizeUninstall({ runnerId: id, purgedAt: now }),
          ).resolves.toBeUndefined();
        } finally {
          if (triggerCreated) await dropTrigger();
          sqlite?.close();
          if (postgres) {
            await postgres.pool.query(
              "DELETE FROM runner_installation_profiles WHERE runner_id = $1",
              [id],
            );
            await postgres.pool.query("DELETE FROM runners WHERE id = $1", [id]);
            await postgres.close();
          }
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  );
