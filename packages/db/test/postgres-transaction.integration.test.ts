import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PostgresDatabaseHandle } from "../src/postgres-database";
import { createPostgresDatabase } from "../src/postgres-database";
import { runPostgresTransaction } from "../src/postgres-transaction";

const connectionString = process.env.AUTOFORGE_TEST_POSTGRES_URL;
describe.skipIf(!connectionString)("PostgreSQL transaction contention recovery", () => {
  let handle: PostgresDatabaseHandle;
  const table = `contention_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    handle = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      poolMax: 4,
      lockTimeoutMs: 25,
    });
    await handle.ready;
    await handle.pool.query(
      `CREATE TABLE ${table} (id integer PRIMARY KEY, value integer NOT NULL)`,
    );
  });
  afterAll(async () => {
    try {
      await handle.pool.query(`DROP TABLE IF EXISTS ${table}`);
    } finally {
      await handle.close();
    }
  });

  it("applies finite request budgets and restores them after migrations", async () => {
    const defaults = createPostgresDatabase({
      connectionString: connectionString!,
      migrationsFolder: resolve("packages/db/drizzle/postgresql"),
      poolMax: 1,
    });
    try {
      await defaults.ready;
      expect((await defaults.pool.query("SHOW lock_timeout")).rows[0]).toEqual({
        lock_timeout: "1s",
      });
      expect((await defaults.pool.query("SHOW statement_timeout")).rows[0]).toEqual({
        statement_timeout: "30s",
      });
      expect((await handle.pool.query("SHOW lock_timeout")).rows[0]).toEqual({
        lock_timeout: "25ms",
      });
    } finally {
      await defaults.close();
    }
  });

  it("rolls back every write before retrying after a real lock timeout", async () => {
    await handle.pool.query(`INSERT INTO ${table} VALUES (1,0)`);
    const writer = await handle.pool.connect();
    let attempts = 0;
    try {
      await writer.query("BEGIN");
      await writer.query(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE`);
      await runPostgresTransaction(handle, async (client) => {
        attempts++;
        await client.query(`INSERT INTO ${table} VALUES (2,0)`);
        try {
          await client.query(`UPDATE ${table} SET value=value+1 WHERE id=1`);
        } catch (error) {
          // Release only after the contender has actually failed, avoiding a timing-based race.
          await writer.query("ROLLBACK");
          throw error;
        }
      });
      expect(attempts).toBe(2);
      expect((await handle.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows).toEqual([
        { id: 1, value: 1 },
        { id: 2, value: 0 },
      ]);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await handle.pool.query(`DELETE FROM ${table}`);
    }
  });

  it("recovers a real opposing-row deadlock without duplicating either transaction", async () => {
    await handle.pool.query(`INSERT INTO ${table} VALUES (1,0),(2,0)`);
    let releaseBarrier!: () => void;
    const bothLocked = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let arrivals = 0;
    const attempts = [0, 0];
    const update = (index: number) =>
      runPostgresTransaction(handle, async (client) => {
        attempts[index]!++;
        await client.query("SET LOCAL lock_timeout = 0");
        await client.query(`UPDATE ${table} SET value=value+1 WHERE id=$1`, [index + 1]);
        if (attempts[index] === 1) {
          if (++arrivals === 2) releaseBarrier();
          await bothLocked;
        }
        await client.query(`UPDATE ${table} SET value=value+1 WHERE id=$1`, [2 - index]);
      });
    try {
      await Promise.all([update(0), update(1)]);
      expect(attempts.reduce((sum, value) => sum + value, 0)).toBe(3);
      expect((await handle.pool.query(`SELECT value FROM ${table} ORDER BY id`)).rows).toEqual([
        { value: 2 },
        { value: 2 },
      ]);
    } finally {
      await handle.pool.query(`DELETE FROM ${table}`);
    }
  });

  it("stops after a bounded number of failures and keeps the pool usable", async () => {
    await handle.pool.query(`INSERT INTO ${table} VALUES (1,0)`);
    const writer = await handle.pool.connect();
    let attempts = 0;
    try {
      await writer.query("BEGIN");
      await writer.query(`SELECT id FROM ${table} WHERE id=1 FOR UPDATE`);
      await expect(
        runPostgresTransaction(handle, async (client) => {
          attempts++;
          await client.query(`UPDATE ${table} SET value=value+1 WHERE id=1`);
        }),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(attempts).toBe(6);
      await writer.query("ROLLBACK");
      await runPostgresTransaction(handle, async (client) => {
        await client.query(`UPDATE ${table} SET value=value+1 WHERE id=1`);
      });
      expect((await handle.pool.query(`SELECT value FROM ${table}`)).rows).toEqual([{ value: 1 }]);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await handle.pool.query(`DELETE FROM ${table}`);
    }
  });

  it("does not retry a constraint violation or commit its preceding writes", async () => {
    let attempts = 0;
    await expect(
      runPostgresTransaction(handle, async (client) => {
        attempts++;
        await client.query(`INSERT INTO ${table} VALUES (1,0)`);
        await client.query(`INSERT INTO ${table} VALUES (1,1)`);
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(attempts).toBe(1);
    expect((await handle.pool.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
  });
});
