import { describe, expect, it } from "vitest";

import { isPublicPath } from "../proxy";

describe("anonymous page routing", () => {
  it("lets signed progress links reach their page-level token guard", () => {
    expect(isPublicPath("/progress/batch-1")).toBe(true);
    expect(isPublicPath("/share/log-token")).toBe(true);
    expect(isPublicPath("/execution-records")).toBe(false);
  });

  it("admits exact business-ID public routes without opening similarly named private routes", () => {
    expect(isPublicPath("/CaseLog")).toBe(true);
    expect(isPublicPath("/Execution")).toBe(true);
    expect(isPublicPath("/Execution/private")).toBe(false);
    expect(isPublicPath("/CaseLogs")).toBe(false);
    expect(isPublicPath("/CaseLog/private")).toBe(false);
  });
});
