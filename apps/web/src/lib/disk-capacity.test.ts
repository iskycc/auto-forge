import { describe, expect, it } from "vitest";

import { diskCapacityStatus, readDiskCapacity } from "./disk-capacity";

describe("disk capacity diagnostics", () => {
  it("uses stable warning and critical thresholds", () => {
    expect(diskCapacityStatus(84.99)).toBe("ok");
    expect(diskCapacityStatus(85)).toBe("warning");
    expect(diskCapacityStatus(94.99)).toBe("warning");
    expect(diskCapacityStatus(95)).toBe("critical");
  });

  it("reads the local data filesystem without exposing paths", async () => {
    await expect(readDiskCapacity(process.cwd())).resolves.toMatchObject({
      status: expect.stringMatching(/^(ok|warning|critical)$/),
      capacityBytes: expect.any(Number),
      availableBytes: expect.any(Number),
      usedPercent: expect.any(Number),
    });
  });

  it("rejects invalid percentages", () => {
    expect(() => diskCapacityStatus(Number.NaN)).toThrow(/使用率/);
    expect(() => diskCapacityStatus(101)).toThrow(/使用率/);
  });
});
