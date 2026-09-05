import { describe, expect, it } from "vitest";
import {
  executionSuitePreferenceKey,
  preferredExecutionSuiteId,
  readExecutionSuitePreference,
  writeExecutionSuitePreference,
} from "./execution-suite-preference";

describe("last selected execution suite", () => {
  it("preserves an explicit choice when the list order changes", () => {
    const suites = [{ id: "latest-edit" }, { id: "last-selected" }];
    expect(preferredExecutionSuiteId(suites, "last-selected")).toBe("last-selected");
    expect(preferredExecutionSuiteId(suites, undefined)).toBe("latest-edit");
  });

  it("requires reselection when the remembered suite is no longer available", () => {
    expect(preferredExecutionSuiteId([{ id: "other-suite" }], "disabled-suite")).toBe("");
    expect(preferredExecutionSuiteId([], undefined)).toBe("");
  });

  it("isolates preferences between users, projects and versions", () => {
    const scope = { userId: "user-a", projectId: "project-a", projectVersionId: "version-a" };
    const keys = [
      scope,
      { ...scope, userId: "user-b" },
      { ...scope, projectId: "project-b" },
      { ...scope, projectVersionId: "version-b" },
    ].map(executionSuitePreferenceKey);
    expect(new Set(keys).size).toBe(4);
    const values = new Map<string, string>();
    const storage = () => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    expect(writeExecutionSuitePreference(storage, keys[0]!, "last-selected")).toBe(true);
    expect(readExecutionSuitePreference(storage, keys[0]!)).toBe("last-selected");
    expect(readExecutionSuitePreference(storage, keys[1]!)).toBeUndefined();
    values.set(keys[0]!, "x".repeat(129));
    expect(readExecutionSuitePreference(storage, keys[0]!)).toBeUndefined();
  });

  it("allows execution to continue when browser storage is unavailable", () => {
    const unavailable = (): Storage => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
    expect(readExecutionSuitePreference(unavailable, "scope")).toBeUndefined();
    expect(writeExecutionSuitePreference(unavailable, "scope", "suite")).toBe(false);
  });
});
