import { describe, expect, it } from "vitest";

import { liteWorkerLaneCount } from "./lite-worker-sizing";

describe("Lite worker pool sizing", () => {
  it("keeps one CPU for the Web thread and uses multiple bounded lanes on a 16U host", () => {
    expect(liteWorkerLaneCount(16, 16)).toBe(4);
    expect(liteWorkerLaneCount(16, 2)).toBe(2);
    expect(liteWorkerLaneCount(2, 16)).toBe(1);
    expect(liteWorkerLaneCount(1, 16)).toBe(1);
  });
});
