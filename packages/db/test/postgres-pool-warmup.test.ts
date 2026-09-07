import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { warmPoolConnections } from "../src/postgres-database";

afterEach(() => vi.restoreAllMocks());

describe("PostgreSQL pool warm-up", () => {
  it("releases every successful connection when another warm-up connection fails", async () => {
    const first = { release: vi.fn() };
    const second = { release: vi.fn() };
    const connectionFailure = new Error("connection limit reached");
    const connect = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(connectionFailure)
      .mockResolvedValueOnce(second);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await warmPoolConnections({ connect } as unknown as Pool, 3);
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("connection limit reached"));
  });
});
