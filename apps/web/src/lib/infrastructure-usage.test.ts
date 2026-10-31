import { afterEach, describe, expect, it, vi } from "vitest";
import { InfrastructureUsageReader } from "./infrastructure-usage";

function fixture(read = vi.fn(async () => ({ metrics: [], notes: [] }))) {
  const source = { provider: "fixture", read };
  const reader = new InfrastructureUsageReader({
    database: source,
    objectStore: source,
    queue: source,
    cache: source,
  });
  return { reader, read };
}

afterEach(() => vi.useRealTimers());
describe("on-demand infrastructure usage", () => {
  it("does no work until a dependency is opened and merges concurrent reads", async () => {
    const { reader, read } = fixture();
    expect(read).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([reader.read("cache"), reader.read("cache")]);
    expect(first).toEqual(second);
    expect(read).toHaveBeenCalledTimes(1);
    await reader.read("cache");
    expect(read).toHaveBeenCalledTimes(1);
    await reader.read("cache", true);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("bounds waiting without creating more probes when a driver remains stuck", async () => {
    vi.useFakeTimers();
    const { reader, read } = fixture(vi.fn(() => new Promise<never>(() => undefined)));
    const first = reader.read("database");
    await vi.advanceTimersByTimeAsync(3001);
    expect(await first).toMatchObject({ status: "unavailable", dependency: "database" });
    const second = reader.read("database", true);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await second).toMatchObject({ status: "unavailable" });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not return connection secrets from failures", async () => {
    const { reader } = fixture(
      vi.fn(async () => {
        throw new Error("redis://user:secret@host:6379");
      }),
    );
    const result = await reader.read("cache");
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
