import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { PlatformOperationsRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";
const now = "2026-10-31T00:00:00.000Z";
async function verifyDeletion(repository: PlatformOperationsRepository, creator: string) {
  const account = await repository.createServiceAccount({
    id: randomUUID(),
    name: "删除验证账号",
    description: "",
    status: "active",
    systemPermissions: ["run.read"],
    projectPermissions: {},
    createdBy: creator,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  });
  async function token(expiresAt = "2026-11-30T00:00:00.000Z") {
    const id = randomUUID();
    return repository.createApiToken({
      id,
      serviceAccountId: account.id,
      name: id,
      prefix: "af_api_test",
      tokenHash: id,
      scopes: ["run.read"],
      expiresAt,
      createdAt: now,
    });
  }
  const active = await token();
  expect(
    await repository.authenticateApiToken({ tokenHash: active.id, usedAt: now }),
  ).not.toBeNull();
  await expect(repository.deleteApiToken({ tokenId: active.id, now })).rejects.toMatchObject({
    code: "API_TOKEN_DELETE_CONFLICT",
  });
  await repository.revokeApiToken({ tokenId: active.id, revokedAt: now });
  await expect(repository.deleteApiToken({ tokenId: active.id, now })).resolves.toMatchObject({
    id: active.id,
    serviceAccountId: account.id,
  });
  expect(await repository.authenticateApiToken({ tokenHash: active.id, usedAt: now })).toBeNull();
  const expired = await token(now);
  await repository.deleteApiToken({ tokenId: expired.id, now });
  await expect(repository.deleteApiToken({ tokenId: expired.id, now })).rejects.toMatchObject({
    code: "API_TOKEN_NOT_FOUND",
  });
  const remaining = await token();
  await expect(
    repository.deleteServiceAccount({ accountId: account.id, expectedRevision: 2 }),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(
    await repository.authenticateApiToken({ tokenHash: remaining.id, usedAt: now }),
  ).not.toBeNull();
  await repository.deleteServiceAccount({ accountId: account.id, expectedRevision: 1 });
  expect(await repository.listApiTokens(account.id)).toEqual([]);
  expect(
    await repository.authenticateApiToken({ tokenHash: remaining.id, usedAt: now }),
  ).toBeNull();
  await expect(
    repository.deleteServiceAccount({ accountId: account.id, expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: "SERVICE_ACCOUNT_NOT_FOUND" });
}
describe("credential deletion in both database adapters", () => {
  it("Lite removes revoked/expired tokens and cascades account tokens without touching historical audits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "af-delete-credentials-"));
    const handle = createSqliteDatabase({
      databasePath: join(directory, "platform.sqlite"),
      migrationsFolder: resolve(import.meta.dirname, "../drizzle/sqlite"),
    });
    try {
      handle.client
        .prepare(
          `INSERT INTO users(id,username,normalized_username,display_name,source,status,force_password_change,failed_login_attempts,created_at,updated_at,version) VALUES('creator','creator','creator','Creator','local','active',0,0,?,?,1)`,
        )
        .run(now, now);
      handle.client
        .prepare(
          `INSERT INTO audit_events(id,actor_type,actor_id,action,resource_type,result,details_json,recorded_at) VALUES('history','user','creator','api_token.create','api_token','succeeded','{}',?)`,
        )
        .run(now);
      await verifyDeletion(new SqlitePlatformOperationsRepository(handle), "creator");
      expect(handle.client.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({
        count: 1,
      });
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.skipIf(!process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    "Full preserves historical audits and recovers after an idle backend disconnects",
    async () => {
      const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL!;
      const admin = new Pool({ connectionString, max: 1 });
      const schema = `delete_credentials_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(connectionString);
      url.searchParams.set("options", `-c search_path=${schema}`);
      const handle = createPostgresDatabase({
        connectionString: url.toString(),
        migrationsFolder: resolve(import.meta.dirname, "../drizzle/postgresql"),
        poolMax: 1,
      });
      try {
        await handle.ready;
        await handle.pool.query(
          `INSERT INTO users(id,username,normalized_username,display_name,source,status,force_password_change,failed_login_attempts,created_at,updated_at,version) VALUES('creator','creator','creator','Creator','local','active',false,0,$1,$1,1)`,
          [now],
        );
        await handle.pool.query(
          `INSERT INTO audit_events(id,actor_type,actor_id,action,resource_type,result,details_json,recorded_at) VALUES('history','user','creator','api_token.create','api_token','succeeded','{}',$1)`,
          [now],
        );
        await verifyDeletion(new PostgresPlatformOperationsRepository(handle), "creator");
        expect(
          (await handle.pool.query("SELECT count(*)::int AS count FROM audit_events")).rows,
        ).toEqual([{ count: 1 }]);
        const first = (await handle.pool.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        expect((await handle.pool.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid).toBe(
          first,
        );
        const disconnected = new Promise<void>((resolve) =>
          handle.pool.once("error", () => resolve()),
        );
        await admin.query("SELECT pg_terminate_backend($1)", [first]);
        await disconnected;
        expect((await handle.pool.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid).not.toBe(
          first,
        );
      } finally {
        await handle.close();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
    30000,
  );
});
