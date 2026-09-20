import { describe, expect, it, vi } from "vitest";
import type { PostgresDatabaseHandle } from "../src/postgres-database";
import { runPostgresTransaction } from "../src/postgres-transaction";

describe("PostgreSQL transaction cleanup", () => {
  it("discards a broken client and retains both failures when rollback fails", async () => {
    const deadlock = Object.assign(new Error("deadlock"), { code: "40P01" });
    const disconnected = Object.assign(new Error("connection lost"), { code: "08006" });
    const query = vi.fn(async (statement: string) => {
      if (statement === "ROLLBACK") throw disconnected;
    });
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));
    const handle = { pool: { connect } } as unknown as PostgresDatabaseHandle;
    const operation = vi.fn(async () => {
      throw deadlock;
    });
    await expect(runPostgresTransaction(handle, operation)).rejects.toMatchObject({
      errors: [deadlock, disconnected],
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
