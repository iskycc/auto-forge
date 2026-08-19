import { describe, expect, it } from "vitest";

import { createRunnerGroupInputSchema, updateRunnerGroupInputSchema } from "../src/runner-group";

describe("runner group contracts", () => {
  it("trims bounded fields and accepts an empty resource pool", () => {
    expect(
      createRunnerGroupInputSchema.parse({
        name: "  华东执行池  ",
        description: "  上海机房  ",
        runnerIds: [],
      }),
    ).toEqual({ name: "华东执行池", description: "上海机房", runnerIds: [] });
  });

  it("rejects duplicate members and requires optimistic revision on updates", () => {
    expect(() =>
      createRunnerGroupInputSchema.parse({
        name: "重复成员",
        runnerIds: ["runner-1", "runner-1"],
      }),
    ).toThrow();
    expect(() => updateRunnerGroupInputSchema.parse({ name: "缺少版本" })).toThrow();
    expect(() => updateRunnerGroupInputSchema.parse({ expectedRevision: 1 })).toThrow();
  });
});
