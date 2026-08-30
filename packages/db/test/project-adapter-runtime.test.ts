import { describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_RESOURCE_LIMITS } from "@autoforge/domain";

import {
  adapterEnvironmentAddress,
  adapterEnvironmentAddressFromExecutionSpec,
  executionResourceLimitsForInputs,
  parseProjectAdapterRuntime,
} from "../src/project-adapter-runtime";

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

  it("rotates Adapter environments from each run's initial offset on every attempt", () => {
    const runtime = {
      suiteName: "suite",
      testName: "test",
      environmentAddresses: ["10.0.0.11", "10.0.0.12", "10.0.0.13"],
      environmentAddressByRunId: {
        "run-a": "10.0.0.11",
        "run-b": "10.0.0.12",
      },
      fallbackEnvironmentAddress: "",
    };

    expect(
      [1, 2, 3, 4].map((attempt) => adapterEnvironmentAddress(runtime, "run-a", attempt)),
    ).toEqual(["10.0.0.11", "10.0.0.12", "10.0.0.13", "10.0.0.11"]);
    expect(
      [1, 2, 3].map((attempt) => adapterEnvironmentAddress(runtime, "run-b", attempt)),
    ).toEqual(["10.0.0.12", "10.0.0.13", "10.0.0.11"]);
  });

  it("derives the available environment pool when reading a legacy batch snapshot", () => {
    const runtime = parseProjectAdapterRuntime(
      JSON.stringify({
        suiteName: "suite",
        testName: "test",
        environmentAddressByRunId: {
          "run-a": "10.0.0.11",
          "run-b": "10.0.0.12",
        },
        fallbackEnvironmentAddress: "",
      }),
    );

    expect(runtime?.environmentAddresses).toEqual(["10.0.0.11", "10.0.0.12"]);
    expect(adapterEnvironmentAddress(runtime!, "run-a", 2)).toBe("10.0.0.12");
  });

  it("reads the actual Adapter address persisted in an assignment execution spec", () => {
    expect(
      adapterEnvironmentAddressFromExecutionSpec(
        JSON.stringify({ adapter: { environmentAddress: "10.0.0.12" } }),
      ),
    ).toBe("10.0.0.12");
    expect(adapterEnvironmentAddressFromExecutionSpec("{}")).toBeUndefined();
    expect(adapterEnvironmentAddressFromExecutionSpec("invalid")).toBeUndefined();
  });
});
