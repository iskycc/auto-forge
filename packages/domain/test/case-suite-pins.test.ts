import { describe, expect, it } from "vitest";
import { orderCaseSuitesByPins } from "../src/case-suite";

describe("task pin presentation order", () => {
  const tasks = [
    { id: "new", name: "任务 1" },
    { id: "ten", name: "任务 10" },
    { id: "two", name: "任务 2" },
    { id: "old", name: "任务 0" },
  ];
  it("orders multiple pins naturally rather than by click time, preserving the unpinned order", () => {
    expect(orderCaseSuitesByPins(tasks, new Set(["ten", "two"])).map((task) => task.id)).toEqual([
      "two",
      "ten",
      "new",
      "old",
    ]);
    expect(tasks.map((task) => task.id)).toEqual(["new", "ten", "two", "old"]);
  });
  it("keeps equal-name pins stable and ignores unavailable task IDs", () => {
    const tasks = [
      { id: "second", name: "任务" },
      { id: "first", name: "任务" },
    ];
    expect(orderCaseSuitesByPins(tasks, new Set(["first", "second", "missing"]))).toEqual(tasks);
    expect(orderCaseSuitesByPins(tasks, new Set())).toEqual(tasks);
  });
});
