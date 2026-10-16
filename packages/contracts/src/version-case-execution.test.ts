import { describe, expect, it } from "vitest";
import { createVersionCaseExecutionSchema } from "./scheduling";

const target = { environmentIp: "10.0.0.21" };

describe("version case execution parameters", () => {
  it.each([
    { className: " com.example.CheckoutTest " },
    { caseDefinitionId: "class" },
    { caseId: " 订单支付_001 " },
  ])("accepts only the case identifier and target IP: %j", (selection) => {
    expect(createVersionCaseExecutionSchema.parse({ ...selection, ...target })).toMatchObject({
      ...target,
      execution: { runnerIds: [] },
    });
  });

  it("trims a fully qualified class name without changing case or nested-class identity", () => {
    expect(
      createVersionCaseExecutionSchema.parse({
        className: " com.example.CheckoutTest$Nested ",
        ...target,
      }),
    ).toMatchObject({ className: "com.example.CheckoutTest$Nested" });
  });

  it("normalizes a Chinese DDT CaseID and accepts IPv6", () => {
    expect(
      createVersionCaseExecutionSchema.parse({
        caseId: " 订单支付_001 ",
        environmentIp: " ::1 ",
      }),
    ).toMatchObject({ caseId: "订单支付_001", environmentIp: "::1" });
  });

  it("accepts optional runner-group and Adapter naming overrides", () => {
    expect(
      createVersionCaseExecutionSchema.safeParse({
        caseId: "A",
        ...target,
        execution: { runnerGroupId: "group", adapter: { suiteName: "Suite" } },
      }).success,
    ).toBe(true);
  });

  it.each([
    {},
    { className: " " },
    { className: "x".repeat(1_025) },
    { className: "com.example.Test", caseDefinitionId: "class" },
    { className: "com.example.Test", caseId: "DDT" },
    { caseId: " " },
    { caseDefinitionId: "" },
    { caseId: "A", caseDefinitionId: "class" },
    { caseId: "A", testStageId: "stage" },
    { caseId: "A", kind: "ddt" },
  ])("rejects missing, ambiguous or unsupported selectors: %j", (selection) => {
    expect(createVersionCaseExecutionSchema.safeParse({ ...selection, ...target }).success).toBe(
      false,
    );
  });

  it.each([undefined, "", "host.local", "https://10.0.0.1", "999.0.0.1"])(
    "rejects an absent or invalid target IP: %s",
    (environmentIp) => {
      expect(
        createVersionCaseExecutionSchema.safeParse({
          caseDefinitionId: "class",
          environmentIp,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    { runnerIds: ["runner"], runnerGroupId: "group" },
    { runnerIds: ["runner", "runner"] },
    { adapter: { environmentAddresses: ["10.0.0.2"] } },
  ])("rejects conflicting resource or target overrides: %j", (execution) => {
    expect(
      createVersionCaseExecutionSchema.safeParse({
        caseDefinitionId: "class",
        ...target,
        execution,
      }).success,
    ).toBe(false);
  });
});
