import { describe, expect, it } from "vitest";

import {
  buildCaseSuiteVersionSnapshot,
  defaultCaseSuiteExecutionPolicy,
  mergeCaseSuiteExecutionPolicy,
  type CaseSuite,
} from "../src/case-suite";

const timestamp = "2026-08-09T00:00:00.000Z";

describe("case suite execution policy", () => {
  it("overrides only the provided fields and replaces collections wholesale", () => {
    const base = {
      ...defaultCaseSuiteExecutionPolicy,
      runnerLabels: ["gpu"],
      artifactPatterns: ["reports/**"],
    };

    const merged = mergeCaseSuiteExecutionPolicy(base, {
      priority: 10,
    });

    expect(merged.priority).toBe(10);
    expect(merged.concurrency).toBe(base.concurrency);
    expect(merged.runnerLabels).toEqual(["gpu"]);
    expect(merged.artifactPatterns).toEqual(["reports/**"]);
  });

  it("treats explicit undefined fields as absent", () => {
    const merged = mergeCaseSuiteExecutionPolicy(defaultCaseSuiteExecutionPolicy, {
      priority: undefined,
      concurrency: 8,
    });

    expect(merged.priority).toBe(defaultCaseSuiteExecutionPolicy.priority);
    expect(merged.concurrency).toBe(8);
  });

  it("does not mutate the base policy collections", () => {
    const base = { ...defaultCaseSuiteExecutionPolicy, runnerLabels: ["gpu"] };
    const merged = mergeCaseSuiteExecutionPolicy(base, {});
    merged.runnerLabels.push("other");
    expect(base.runnerLabels).toEqual(["gpu"]);
  });

  it("drops legacy parameter templates while normalizing stored policies", () => {
    const merged = mergeCaseSuiteExecutionPolicy(defaultCaseSuiteExecutionPolicy, {
      parameters: { REGION: "cn" },
    } as unknown as Parameters<typeof mergeCaseSuiteExecutionPolicy>[1]);

    expect(merged).not.toHaveProperty("parameters");
  });
});

describe("case suite version snapshot", () => {
  it("captures the post-change state with sorted case ids", () => {
    const suite: CaseSuite = {
      id: "suite-1",
      projectId: "project-1",
      name: "Smoke",
      description: "smoke suite",
      version: 3,
      revision: 3,
      status: "active",
      enabled: true,
      policy: { ...defaultCaseSuiteExecutionPolicy, priority: 5 },
      caseCount: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const snapshot = buildCaseSuiteVersionSnapshot(suite, ["case-b", "case-a"]);

    expect(snapshot).toEqual({
      name: "Smoke",
      description: "smoke suite",
      status: "active",
      enabled: true,
      policy: { ...defaultCaseSuiteExecutionPolicy, priority: 5 },
      caseDefinitionIds: ["case-a", "case-b"],
    });
  });
});
