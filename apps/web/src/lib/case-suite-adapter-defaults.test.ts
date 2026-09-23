import { describe, expect, it } from "vitest";
import { caseSuiteAdapterDefaults } from "./case-suite-adapter-defaults";

const version = {
  name: "1.2.3",
  stages: [
    { id: "old", name: "旧阶段", status: "archived" as const },
    { id: "sit", name: "SIT", status: "active" as const },
    { id: "uat", name: "UAT", status: "active" as const },
  ],
};

describe("task adapter name defaults", () => {
  it("uses the selected stage of the task version", () => {
    expect(caseSuiteAdapterDefaults("支付平台", version, "uat")).toEqual({
      suiteName: "支付平台",
      testName: "1.2.3 - UAT",
    });
  });

  it.each([undefined, "other-version-stage", "old"])(
    "falls back to this version's first active stage for %s",
    (stageId) => {
      expect(caseSuiteAdapterDefaults("支付平台", version, stageId).testName).toBe("1.2.3 - SIT");
    },
  );

  it("does not invent a stage or trailing separator when the version has none", () => {
    expect(caseSuiteAdapterDefaults("支付平台", { name: "2.0", stages: [] })).toEqual({
      suiteName: "支付平台",
      testName: "2.0",
    });
    expect(caseSuiteAdapterDefaults("支付平台", undefined)).toEqual({
      suiteName: "支付平台",
      testName: "",
    });
  });
});
