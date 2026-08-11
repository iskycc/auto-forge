import { describe, expect, it } from "vitest";

import { nextCronOccurrence, validateCronExpression } from "../src/schedule-expression";

describe("schedule expression", () => {
  it("calculates the next occurrence in an IANA time zone", () => {
    expect(
      nextCronOccurrence("0 9 * * 1-5", "Asia/Shanghai", new Date("2026-08-07T01:00:00.000Z")),
    ).toEqual(new Date("2026-08-10T01:00:00.000Z"));
  });

  it("supports steps and Sunday alias", () => {
    expect(nextCronOccurrence("*/15 * * * 7", "UTC", new Date("2026-08-09T00:01:00.000Z"))).toEqual(
      new Date("2026-08-09T00:15:00.000Z"),
    );
  });

  it("rejects invalid expressions and time zones", () => {
    expect(() => validateCronExpression("61 * * * *", "UTC")).toThrow("Cron 表达式包含无效字段");
    expect(() => validateCronExpression("0 0 * * *", "Mars/Olympus")).toThrow(
      "计划时区不是有效的 IANA 时区",
    );
  });
});
