import { describe, expect, it } from "vitest";

import { backgroundResourcePlan, fullWorkerPoolMaxPerLane, webResourcePlan } from "./worker-sizing";

describe("work thread lane sizing", () => {
  it("expands standalone background work without exceeding its database and memory budgets", () => {
    const resources = { cpuCapacity: 16, memoryCapacityBytes: 32 * 1024 ** 3 };
    const plan = backgroundResourcePlan(resources, 16, 10);
    expect(plan.maintenanceLanes).toBe(10);
    expect(plan.snapshotLanes).toBe(4);
    expect((plan.maintenanceLanes + plan.snapshotLanes) * plan.workerHeapMb).toBeLessThanOrEqual(
      32 * 1024 * 0.4,
    );
    expect(backgroundResourcePlan(resources, 2, 10).maintenanceLanes).toBe(2);
    expect(
      backgroundResourcePlan({ cpuCapacity: 4, memoryCapacityBytes: 4 * 1024 ** 3 }, 16, 10)
        .maintenanceLanes,
    ).toBe(3);
  });
  it.each(["lite", "full"] as const)(
    "scales independent CPU work within one memory budget in %s",
    (mode) => {
      const small = webResourcePlan(
        { cpuCapacity: 1, memoryCapacityBytes: 4 * 1024 ** 3 },
        mode,
        10,
      );
      const medium = webResourcePlan(
        { cpuCapacity: 4, memoryCapacityBytes: 4 * 1024 ** 3 },
        mode,
        10,
      );
      const large = webResourcePlan(
        { cpuCapacity: 16, memoryCapacityBytes: 32 * 1024 ** 3 },
        mode,
        10,
      );
      const uploadRole = mode === "lite" ? "uploadLanes" : "logWriteLanes";
      expect(small[uploadRole]).toBe(1);
      expect(medium[uploadRole]).toBeGreaterThan(1);
      expect(large[uploadRole]).toBeGreaterThan(medium[uploadRole]);
      expect(large.snapshotLanes).toBeGreaterThan(1);
      expect(large.workerHeapMb).toBeGreaterThan(256);
      expect(large.schedulingLanes).toBeLessThanOrEqual(10);
      const count =
        1 +
        large.schedulingLanes +
        large.controlLanes +
        large.uploadLanes +
        large.logReadLanes +
        large.logWriteLanes +
        large.snapshotLanes +
        large.maintenanceLanes;
      expect(count * large.workerHeapMb).toBeLessThanOrEqual(32 * 1024 * 0.4);
    },
  );
  it("keeps one CPU for the Web thread and uses multiple bounded lanes on a 16U host", () => {
    expect(
      webResourcePlan({ cpuCapacity: 16, memoryCapacityBytes: 32 * 1024 ** 3 }, "lite")
        .schedulingLanes,
    ).toBeGreaterThan(4);
    expect(
      webResourcePlan({ cpuCapacity: 1.5, memoryCapacityBytes: 32 * 1024 ** 3 }, "lite")
        .schedulingLanes,
    ).toBe(1);
  });

  it("bounds Full lanes and divides one PostgreSQL connection budget between them", () => {
    expect(
      webResourcePlan({ cpuCapacity: 16, memoryCapacityBytes: 32 * 1024 ** 3 }, "full", 10)
        .schedulingLanes,
    ).toBeGreaterThan(2);
    expect(fullWorkerPoolMaxPerLane(10, 2)).toBe(5);
    expect(Array.from({ length: 3 }, (_, index) => fullWorkerPoolMaxPerLane(10, 3, index))).toEqual(
      [4, 3, 3],
    );
    expect(
      webResourcePlan({ cpuCapacity: 16, memoryCapacityBytes: 32 * 1024 ** 3 }, "full", 1)
        .schedulingLanes,
    ).toBe(1);
    expect(fullWorkerPoolMaxPerLane(1, 1)).toBe(1);
  });
});
