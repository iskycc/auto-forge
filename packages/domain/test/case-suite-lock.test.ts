import { describe, expect, it } from "vitest";
import {
  assertCaseSuiteEditable,
  assertCaseSuiteLockOwner,
  assertCaseSuiteUpdateAllowed,
} from "../src/case-suite";

describe("task edit ownership", () => {
  const suite = { status: "active" as const, lockedBy: "owner" };
  it("blocks other users and missing identities while allowing its owner", () => {
    expect(() => assertCaseSuiteEditable(suite, "other")).toThrow("锁定");
    expect(() => assertCaseSuiteEditable(suite)).toThrow("锁定");
    expect(() => assertCaseSuiteEditable(suite, "owner")).not.toThrow();
  });
  it("protects deletion and restore even when the archived task is otherwise readable", () => {
    expect(() => assertCaseSuiteLockOwner(suite, "other")).toThrow("锁定");
    expect(() =>
      assertCaseSuiteUpdateAllowed({ ...suite, status: "archived" }, { archived: false }, "other"),
    ).toThrow("锁定");
    expect(() =>
      assertCaseSuiteUpdateAllowed({ ...suite, status: "archived" }, { archived: false }, "owner"),
    ).not.toThrow();
  });
});
