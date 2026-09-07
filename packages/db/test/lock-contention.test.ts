import { describe, expect, it } from "vitest";
import { isDatabaseLockContentionError, isSqliteLockContentionError } from "../src/lock-contention";

describe("database lock classification", () => {
  it.each(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED", "55P03", "40P01", "40001"])(
    "recognizes %s through an adapter cause without treating it as a permanent snapshot failure",
    (code) => {
      const failure = new Error("adapter operation failed", { cause: { code } });
      expect(isDatabaseLockContentionError(failure)).toBe(true);
      expect(isSqliteLockContentionError(failure)).toBe(code.startsWith("SQLITE_"));
    },
  );

  it.each(["57014", "23505", "SQLITE_CORRUPT", "SQLITE_BUSYNESS"])(
    "keeps non-lock error %s on the normal failure path",
    (code) => {
      expect(isDatabaseLockContentionError({ code })).toBe(false);
    },
  );

  it("terminates on cyclic causes", () => {
    const failure: { cause?: unknown } = {};
    failure.cause = failure;
    expect(isDatabaseLockContentionError(failure)).toBe(false);
  });
});
