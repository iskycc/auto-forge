import { describe, expect, it } from "vitest";
import { readDiagnosticRuntime } from "./diagnostic-runtime";

describe("diagnostic resource scope", () => {
  it("preserves fractional CPU limits and bounds available memory to the container capacity", () => {
    const report = readDiagnosticRuntime(
      { cpuCapacity: 0.5, memoryCapacityBytes: 1024 },
      { distributed: true, nodeId: "platform-2" },
      false,
    );
    expect(report.cpuCapacity).toBe(0.5);
    expect(report.memoryCapacityBytes).toBe(1024);
    expect(report.availableMemoryBytes).toBeLessThanOrEqual(1024);
    expect(report.processRssBytes).toBeGreaterThan(0);
    expect(report.heapLimitBytes).toBeGreaterThan(0);
    expect(report).toMatchObject({
      nodeId: "platform-2",
      distributed: true,
      backgroundAllowed: false,
    });
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
