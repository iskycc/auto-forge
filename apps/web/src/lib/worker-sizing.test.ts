import { describe, expect, it } from "vitest";

import { workerLaneCount } from "./worker-sizing";

describe("work thread lane sizing", () => {
  it("keeps one CPU for the Web thread and uses multiple bounded lanes on a 16U host", () => {
    expect(workerLaneCount(16, 16)).toBe(4);
    expect(workerLaneCount(16, 2)).toBe(2);
    expect(workerLaneCount(2, 16)).toBe(1);
    expect(workerLaneCount(1, 16)).toBe(1);
  });
});
