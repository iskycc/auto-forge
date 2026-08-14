import { describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_RESOURCE_LIMITS } from "@autoforge/domain";

import { executionResourceLimitsForInputs } from "../src/project-adapter-runtime";

describe("Adapter execution resource limits", () => {
  it("grows the workspace budget beyond the legacy 10 GiB default for large archives", () => {
    const twentyGiB = 20 * 1_024 * 1_024 * 1_024;

    const limits = executionResourceLimitsForInputs([1_024, twentyGiB], true);

    expect(limits.diskBytes).toBeGreaterThan(twentyGiB);
    expect(limits.diskBytes).toBeGreaterThan(DEFAULT_EXECUTION_RESOURCE_LIMITS.diskBytes);
    expect(limits.fileCount).toBe(100_000);
  });

  it("keeps the normal TestNG executor defaults when Adapter extraction is not used", () => {
    expect(executionResourceLimitsForInputs([1_024], false)).toEqual(
      DEFAULT_EXECUTION_RESOURCE_LIMITS,
    );
  });
});
