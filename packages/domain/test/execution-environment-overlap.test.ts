import { describe, expect, it } from "vitest";
import { overlappingEnvironmentAddresses } from "../src/execution-environment-overlap";

describe("execution environment overlap", () => {
  it.each([
    { requested: ["10.0.0.1"], occupied: ["10.0.0.1"], expected: ["10.0.0.1"] },
    {
      requested: ["10.0.0.1", "10.0.0.2"],
      occupied: ["10.0.0.2", "10.0.0.3"],
      expected: ["10.0.0.2"],
    },
    { requested: ["10.0.0.1"], occupied: ["10.0.0.10"], expected: [] },
    {
      requested: ["2001:0DB8:0:0:0:0:0:1"],
      occupied: ["2001:db8::1"],
      expected: ["2001:0DB8:0:0:0:0:0:1"],
    },
    { requested: ["10.0.0.1"], occupied: ["::ffff:10.0.0.1"], expected: ["10.0.0.1"] },
    { requested: [" 10.0.0.1 "], occupied: ["10.0.0.1"], expected: [" 10.0.0.1 "] },
    {
      requested: ["legacy.internal"],
      occupied: ["LEGACY.INTERNAL"],
      expected: ["legacy.internal"],
    },
    { requested: [], occupied: ["10.0.0.1"], expected: [] },
  ])("compares complete addresses: $requested / $occupied", ({ requested, occupied, expected }) => {
    expect(overlappingEnvironmentAddresses(requested, occupied)).toEqual(expected);
  });
});
