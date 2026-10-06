import { describe, expect, it } from "vitest";
import { setCaseSuitePinInputSchema } from "../src/case-suite-pins";

describe("personal task pin input", () => {
  it.each([true, false])("accepts the explicit desired state %s", (pinned) => {
    expect(setCaseSuitePinInputSchema.parse({ pinned })).toEqual({ pinned });
  });
  it("rejects coercion and client-selected actors", () => {
    for (const input of [
      {},
      { pinned: "true" },
      { pinned: 1 },
      { pinned: true, userId: "other-user" },
    ]) {
      expect(setCaseSuitePinInputSchema.safeParse(input).success).toBe(false);
    }
  });
});
