import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { PlatformOperationsRepository } from "@autoforge/application";
import { createSqliteDatabase } from "../src/database";
import { createPostgresDatabase } from "../src/postgres-database";
import { SqlitePlatformOperationsRepository } from "../src/sqlite-platform-operations";
import { PostgresPlatformOperationsRepository } from "../src/postgres-platform-operations";

const recordedAt = "2026-09-20T00:00:00.000Z";
type TokenHarness = {
  repository: PlatformOperationsRepository;
  tokenId: string;
  accountId: string;
  tokenHash: string;
  holdWriter(): Promise<void>;
  releaseWriter(): Promise<void>;
  close(): Promise<void>;
};

async function createHarness(mode: "sqlite" | "postgres"): Promise<TokenHarness> {
  const suffix = randomUUID();
  const tokenId = `token-${suffix}`;
  const tokenHash = `hash-${suffix}`;
  const accountId = `account-${suffix}`;
  const userId = `user-${suffix}`;
  let harness: TokenHarness;
  if (mode === "sqlite") {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-token-contention-"));
    const handle = createSqliteDatabase({
      databasePath: join(directory, "platform.sqlite"),
      migrationsFolder: resolve("packages/db/drizzle/sqlite"),
      busyTimeoutMs: 25,
    });
    const writer = new Database(handle.client.name);
    handle.client
      .prepare(
        `INSERT INTO users
      (id,username,normalized_username,display_name,source,status,created_at,updated_at)
      VALUES (?,?,?,'Audit user','local','active',?,?)`,
      )
      .run(userId, userId, userId, recordedAt, recordedAt);
    harness = {
      repository: new SqlitePlatformOperationsRepository(handle),
      tokenId,
      accountId,
      tokenHash,
      async holdWriter() {
        writer.exec("BEGIN IMMEDIATE");
      },
      async releaseWriter() {
        if (writer.inTransaction) writer.exec("ROLLBACK");
      },
      async close() {
        if (writer.inTransaction) writer.exec("ROLLBACK");
        writer.close();
        handle.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } else {
    const handle = createPostgresDatabase({
      connectionString: process.env.AUTOFORGE_TEST_POSTGRES_URL!,
      migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      poolMax: 2,
      lockTimeoutMs: 25,
    });
    await handle.ready;
    await handle.pool.query(
      `INSERT INTO users
      (id,username,normalized_username,display_name,source,status,created_at,updated_at)
      VALUES ($1,$1,$1,'Audit user','local','active',$2,$2)`,
      [userId, recordedAt],
    );
    const writer = await handle.pool.connect();
    harness = {
      repository: new PostgresPlatformOperationsRepository(handle),
      tokenId,
      accountId,
      tokenHash,
      async holdWriter() {
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM api_tokens WHERE id=$1 FOR UPDATE", [tokenId]);
      },
      async releaseWriter() {
        await writer.query("ROLLBACK");
      },
      async close() {
        await writer.query("ROLLBACK");
        writer.release();
        await handle.pool.query("DELETE FROM api_tokens WHERE id=$1", [tokenId]);
        await handle.pool.query("DELETE FROM service_accounts WHERE id=$1", [accountId]);
        await handle.pool.query("DELETE FROM users WHERE id=$1", [userId]);
        await handle.close();
      },
    };
  }
  await harness.repository.createServiceAccount({
    id: accountId,
    name: accountId,
    description: "",
    status: "active",
    systemPermissions: ["run.read"],
    projectPermissions: {},
    createdBy: userId,
    createdAt: recordedAt,
    updatedAt: recordedAt,
    revision: 1,
  });
  await harness.repository.createApiToken({
    id: tokenId,
    serviceAccountId: accountId,
    name: "Poller",
    prefix: "test",
    tokenHash,
    scopes: ["run.read", "run.create"],
    createdAt: recordedAt,
    expiresAt: "2026-09-21T00:00:00.000Z",
  });
  return harness;
}

for (const mode of ["sqlite", "postgres"] as const) {
  describe.skipIf(mode === "postgres" && !process.env.AUTOFORGE_TEST_POSTGRES_URL)(
    `${mode} API token activity`,
    () => {
      it("distinguishes a duplicate account name from unrelated database failures", async () => {
        const harness = await createHarness(mode);
        try {
          const account = (await harness.repository.listServiceAccounts()).find(
            (item) => item.id === harness.accountId,
          )!;
          await expect(
            harness.repository.createServiceAccount({ ...account, id: randomUUID() }),
          ).rejects.toMatchObject({ code: "SERVICE_ACCOUNT_NAME_CONFLICT" });
          await expect(
            harness.repository.createServiceAccount({
              ...account,
              id: randomUUID(),
              name: randomUUID(),
              createdBy: "missing-user",
            }),
          ).rejects.toMatchObject({
            code: mode === "sqlite" ? "SQLITE_CONSTRAINT_FOREIGNKEY" : "23503",
          });
        } finally {
          await harness.close();
        }
      });

      it("authenticates under a writer lock and defers optional activity without losing authorization", async () => {
        const harness = await createHarness(mode);
        try {
          await harness.holdWriter();
          const authenticated = await harness.repository.authenticateApiToken({
            tokenHash: harness.tokenHash,
            usedAt: recordedAt,
          });
          expect(authenticated?.effectiveScopes).toEqual(["run.read"]);
          expect(authenticated?.token.lastUsedAt).toBeUndefined();
          await harness.releaseWriter();
          expect(
            await harness.repository.authenticateApiToken({
              tokenHash: harness.tokenHash,
              usedAt: recordedAt,
            }),
          ).toMatchObject({ token: { lastUsedAt: recordedAt } });
        } finally {
          await harness.close();
        }
      });

      it("recovers token revocation after a competing writer releases its lock", async () => {
        const harness = await createHarness(mode);
        let release: Promise<void> | undefined;
        try {
          await harness.holdWriter();
          release = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              harness.releaseWriter().then(resolve, reject);
            }, 150);
          });
          await expect(
            harness.repository.revokeApiToken({ tokenId: harness.tokenId, revokedAt: recordedAt }),
          ).resolves.toMatchObject({ revokedAt: recordedAt });
          await expect(
            harness.repository.authenticateApiToken({
              tokenHash: harness.tokenHash,
              usedAt: recordedAt,
            }),
          ).resolves.toBeNull();
        } finally {
          await release;
          await harness.close();
        }
      });

      it("coalesces polling activity while still observing token revocation immediately", async () => {
        const harness = await createHarness(mode);
        try {
          await harness.repository.authenticateApiToken({
            tokenHash: harness.tokenHash,
            usedAt: recordedAt,
          });
          for (const usedAt of ["2026-09-20T00:00:01.000Z", "2026-09-20T00:04:59.000Z"]) {
            expect(
              await harness.repository.authenticateApiToken({
                tokenHash: harness.tokenHash,
                usedAt,
              }),
            ).toMatchObject({ token: { lastUsedAt: recordedAt } });
          }
          const nextActivity = "2026-09-20T00:05:00.000Z";
          expect(
            await harness.repository.authenticateApiToken({
              tokenHash: harness.tokenHash,
              usedAt: nextActivity,
            }),
          ).toMatchObject({ token: { lastUsedAt: nextActivity } });
          await harness.repository.revokeApiToken({
            tokenId: harness.tokenId,
            revokedAt: nextActivity,
          });
          await harness.holdWriter();
          expect(
            await harness.repository.authenticateApiToken({
              tokenHash: harness.tokenHash,
              usedAt: nextActivity,
            }),
          ).toBeNull();
        } finally {
          await harness.close();
        }
      });
    },
  );
}
