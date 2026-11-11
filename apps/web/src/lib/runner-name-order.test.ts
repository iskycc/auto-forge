import { describe, expect, it } from "vitest";
import { orderRunnersByName } from "./runner-name-order";

describe("Runner inventory name order", () => {
  it.each(["node-", "执行节点"])("uses ascending natural names for %s", (prefix) => {
    const runners = [10, 2, 1].map((number) => ({
      id: String(number),
      name: `${prefix}${number}`,
    }));
    expect(orderRunnersByName(runners).map((runner) => runner.name)).toEqual([
      `${prefix}1`,
      `${prefix}2`,
      `${prefix}10`,
    ]);
  });

  it("breaks equivalent names by ID regardless of heartbeat or input order", () => {
    const runners = [
      { id: "runner-z", name: "node-2", lastSeenAt: "2026-11-11T00:00:03Z" },
      { id: "runner-a", name: "node-2", lastSeenAt: "2026-11-11T00:00:02Z" },
      { id: "runner-b", name: "node-1", lastSeenAt: "2026-11-11T00:00:01Z" },
    ];
    const expected = ["runner-b", "runner-a", "runner-z"];
    expect(orderRunnersByName(runners).map((runner) => runner.id)).toEqual(expected);
    const nextHeartbeat = [...runners].reverse().map((runner, index) => ({
      ...runner,
      lastSeenAt: `2026-11-11T00:01:0${index}Z`,
    }));
    expect(orderRunnersByName(nextHeartbeat).map((runner) => runner.id)).toEqual(expected);
    expect(runners.map((runner) => runner.id)).toEqual(["runner-z", "runner-a", "runner-b"]);
  });

  it("accepts an empty inventory", () => {
    expect(orderRunnersByName([])).toEqual([]);
  });
});
