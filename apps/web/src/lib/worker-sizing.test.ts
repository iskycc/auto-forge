import { describe, expect, it } from "vitest";

import { fullWorkerLaneCount, fullWorkerPoolMaxPerLane, workerLaneCount } from "./worker-sizing";

describe("work thread lane sizing", () => {
  it("keeps one CPU for the Web thread and uses multiple bounded lanes on a 16U host", () => {
    expect(workerLaneCount(16, 16)).toBe(4);
    expect(workerLaneCount(16, 2)).toBe(2);
    expect(workerLaneCount(2, 16)).toBe(1);
    expect(workerLaneCount(1, 16)).toBe(1);
  });

  it("bounds Full lanes and divides one PostgreSQL connection budget between them", () => {
    expect(fullWorkerLaneCount(16, 16, 10)).toBe(2);
    expect(fullWorkerPoolMaxPerLane(10, 2)).toBe(5);
    expect(fullWorkerLaneCount(16, 16, 1)).toBe(1);
    expect(fullWorkerPoolMaxPerLane(1, 1)).toBe(1);
  });
});
