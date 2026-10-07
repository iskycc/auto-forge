import { describe, expect, it } from "vitest";
import {
  FailureCaseSuiteNameSequence,
  failureCaseSuiteNameDate,
  formatFailureCaseSuiteName,
} from "../src/failure-case-suite-name";

const source = { sourceName: "原任务", date: "20261007" };

describe("failure task default names", () => {
  it("uses the platform timezone across a UTC day boundary", () => {
    const now = new Date("2026-10-06T16:05:00.000Z");
    expect(failureCaseSuiteNameDate(now, "Asia/Shanghai")).toBe("20261007");
    expect(failureCaseSuiteNameDate(now, "UTC")).toBe("20261006");
  });

  it("starts without a sequence and adds two digits when occupied", () => {
    const names = new FailureCaseSuiteNameSequence(source);
    expect(names.availableName()).toBe("原任务 Rerun-20261007");
    names.observe(["原任务 Rerun-20261007"]);
    expect(names.availableName()).toBe("原任务 Rerun-2026100701");
    names.observe(["原任务 Rerun-2026100701", "原任务 Rerun-2026100702"]);
    expect(names.availableName()).toBe("原任务 Rerun-2026100703");
  });

  it("continues numerically beyond 99 and ignores other names or malformed suffixes", () => {
    const names = new FailureCaseSuiteNameSequence(source);
    names.observe([
      "原任务 Rerun-20261007",
      "原任务 Rerun-2026100799",
      "原任务 Rerun-20261007100",
      "其他任务 Rerun-20261007999",
      "原任务 Rerun-202610070099",
      "原任务 Rerun-20261007123x",
    ]);
    expect(names.availableName()).toBe("原任务 Rerun-20261007101");
  });

  it("preserves the date and sequence when long source names need truncation", () => {
    const longSource = { ...source, sourceName: "😀".repeat(60) };
    const names = new FailureCaseSuiteNameSequence(longSource);
    const base = formatFailureCaseSuiteName(longSource);
    names.observe([base, formatFailureCaseSuiteName(longSource, 99)]);
    const next = names.availableName();
    expect(base.length).toBeLessThanOrEqual(120);
    expect(next.length).toBeLessThanOrEqual(120);
    expect(next.endsWith(" Rerun-20261007100")).toBe(true);
    expect(next).toMatch(/^(?:😀)+ Rerun-20261007100$/u);
  });

  it("matches literal source names containing punctuation and an earlier Rerun marker", () => {
    const literal = { ...source, sourceName: "任务_%[A] Rerun-20261007" };
    const names = new FailureCaseSuiteNameSequence(literal);
    names.observe([formatFailureCaseSuiteName(literal), formatFailureCaseSuiteName(literal, 1)]);
    expect(names.availableName()).toBe("任务_%[A] Rerun-20261007 Rerun-2026100702");
  });
});
