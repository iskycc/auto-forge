import { describe, expect, it } from "vitest";
import { versionInitializationInputSchema } from "@autoforge/contracts";
import { inheritedSuiteId, matchInitializationStage } from "../src/initialize-project-version";

describe("version initialization boundaries", () => {
  it("allows independent steps without requiring unrelated setup", () => {
    expect(
      versionInitializationInputSchema.parse({ sourceProjectVersionId: "old", step: "runtime" }),
    ).toMatchObject({ step: "runtime", stageMappings: [] });
  });
  it("keeps the copied task identity stable across retries and distinct across versions", () => {
    expect(inheritedSuiteId("suite", "version")).toBe(inheritedSuiteId("suite", "version"));
    expect(inheritedSuiteId("suite", "version")).not.toBe(inheritedSuiteId("suite", "other"));
  });
  it("matches stage names only inside the supplied target version and refuses archived matches", () => {
    const stages = [
      { id: "active", name: " SIT ", status: "active" as const },
      { id: "archived", name: "UAT", status: "archived" as const },
    ];
    expect(matchInitializationStage(stages, "sit")?.id).toBe("active");
    expect(matchInitializationStage(stages, "uat")).toBeUndefined();
    expect(matchInitializationStage(stages, "missing")).toBeUndefined();
  });
});
