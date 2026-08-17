import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { describe, expect, it } from "vitest";

import {
  casePathOf,
  matchCasePaths,
  normalizeCasePath,
  parseCasePathColumn,
} from "./case-path-import";

describe("case path import", () => {
  it("builds the case path from directory and display name", () => {
    expect(
      casePathOf(caseDefinition({ directoryPath: "com/example", displayName: "CheckoutTest" })),
    ).toBe("com/example/CheckoutTest");
    expect(casePathOf(caseDefinition({ directoryPath: "", displayName: "SmokeTest" }))).toBe(
      "SmokeTest",
    );
  });

  it("normalizes leading, trailing and repeated slashes", () => {
    expect(normalizeCasePath("  /com//example/CheckoutTest/ ")).toBe("com/example/CheckoutTest");
    expect(normalizeCasePath("com/example/CheckoutTest")).toBe("com/example/CheckoutTest");
    expect(normalizeCasePath("///")).toBe("");
  });

  it("skips a header row equal to 用例路径", () => {
    expect(parseCasePathColumn("用例路径\ncom/example/CheckoutTest\n")).toEqual([
      "com/example/CheckoutTest",
    ]);
    expect(parseCasePathColumn("com/example/CheckoutTest\n")).toEqual(["com/example/CheckoutTest"]);
  });

  it("parses quoted CSV cells and ignores later columns", () => {
    const text = '"用例路径","备注"\n"com/example/CheckoutTest","冒烟,核心"\n';
    expect(parseCasePathColumn(text)).toEqual(["com/example/CheckoutTest"]);
    expect(parseCasePathColumn('"com/example/""Quoted""Test",x\n')).toEqual([
      'com/example/"Quoted"Test',
    ]);
  });

  it("prefers tab-separated columns over comma splitting", () => {
    expect(parseCasePathColumn("com/example/CheckoutTest\t冒烟用例\n")).toEqual([
      "com/example/CheckoutTest",
    ]);
  });

  it("skips blank lines and trims surrounding whitespace", () => {
    const text = "\n  \ncom/example/CheckoutTest\n   \ncom/example/LoginTest\n";
    expect(parseCasePathColumn(text)).toEqual([
      "com/example/CheckoutTest",
      "com/example/LoginTest",
    ]);
  });

  it("deduplicates normalized paths while keeping first-seen order", () => {
    const text =
      "com/example/LoginTest\n/com/example/CheckoutTest/\ncom//example/CheckoutTest\ncom/example/LoginTest\n";
    expect(parseCasePathColumn(text)).toEqual([
      "com/example/LoginTest",
      "com/example/CheckoutTest",
    ]);
  });

  it("matches paths exactly after normalization and reports the rest", () => {
    const cases = [
      caseDefinition({ id: "case-1", directoryPath: "com/example", displayName: "CheckoutTest" }),
      caseDefinition({ id: "case-2", directoryPath: "", displayName: "SmokeTest" }),
    ];
    const result = matchCasePaths(cases, [
      "/com/example/CheckoutTest/",
      "com/example/NoSuchCase",
      "SmokeTest",
    ]);
    expect(result.matched.map((item) => item.id)).toEqual(["case-1", "case-2"]);
    expect(result.unmatched).toEqual(["com/example/NoSuchCase"]);
  });

  it("also matches the dotted fully-qualified class name form", () => {
    const cases = [
      caseDefinition({ id: "case-1", directoryPath: "com/example", displayName: "CheckoutTest" }),
      caseDefinition({
        id: "case-2",
        directoryPath: "com/example",
        displayName: "LoginTest",
        className: "com.example.LoginTest",
      }),
    ];
    const result = matchCasePaths(cases, [
      "com.example.CheckoutTest",
      "com/example/LoginTest",
      "org.example.Unknown",
    ]);
    expect(result.matched.map((item) => item.id)).toEqual(["case-1", "case-2"]);
    expect(result.unmatched).toEqual(["org.example.Unknown"]);
  });
});

function caseDefinition(overrides: Partial<CaseDefinitionWithMethods>): CaseDefinitionWithMethods {
  return {
    id: "case-1",
    projectId: "project-1",
    directoryPath: "com/example",
    sourceId: "source-1",
    className: "com.example.CheckoutTest",
    packageName: "com.example",
    displayName: "CheckoutTest",
    description: "",
    tags: [],
    enabled: true,
    archived: false,
    groups: [],
    parameters: {},
    currentVersion: 1,
    revision: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    methods: [],
    ...overrides,
  };
}
