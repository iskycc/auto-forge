import { describe, expect, it } from "vitest";

import { isPublicPath } from "../proxy";

describe("anonymous page routing", () => {
  it("lets signed progress links reach their page-level token guard", () => {
    expect(isPublicPath("/progress/batch-1")).toBe(true);
    expect(isPublicPath("/share/log-token")).toBe(true);
    expect(isPublicPath("/execution-records")).toBe(false);
  });
});
