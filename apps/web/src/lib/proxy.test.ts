import { describe, expect, it } from "vitest";

import { isPublicPath, proxy } from "../proxy";
import { NextRequest } from "next/server";
import { AUTHENTICATION_PAGE_PATH_HEADER } from "./authentication-return-path";

describe("anonymous page routing", () => {
  it("preserves the protected destination before login without internal RSC parameters", () => {
    const response = proxy(
      new NextRequest("http://platform.local/execution-records?kind=single&_rsc=internal"),
    );
    const target = new URL(response.headers.get("location")!);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("returnTo")).toBe("/execution-records?kind=single");
  });

  it("overwrites spoofed page context for authoritative expired-session redirects", () => {
    const response = proxy(
      new NextRequest("http://platform.local/execution-records?kind=single", {
        headers: {
          cookie: "autoforge_session=expired",
          [AUTHENTICATION_PAGE_PATH_HEADER]: "/attacker",
        },
      }),
    );
    expect(response.headers.get(`x-middleware-request-${AUTHENTICATION_PAGE_PATH_HEADER}`)).toBe(
      "/execution-records?kind=single",
    );
  });
  it("lets signed progress links reach their page-level token guard", () => {
    expect(isPublicPath("/progress/batch-1")).toBe(true);
    expect(isPublicPath("/share/log-token")).toBe(true);
    expect(isPublicPath("/execution-records")).toBe(false);
  });

  it("admits exact business-ID public routes without opening similarly named private routes", () => {
    expect(isPublicPath("/CaseLog")).toBe(true);
    expect(isPublicPath("/Execution")).toBe(true);
    expect(isPublicPath("/RunTask")).toBe(true);
    expect(isPublicPath("/CaseAnalysis")).toBe(true);
    expect(isPublicPath("/CaseAnalysis/private")).toBe(false);
    expect(isPublicPath("/register")).toBe(true);
    expect(isPublicPath("/register/private")).toBe(false);
    expect(isPublicPath("/RunTask/private")).toBe(false);
    expect(isPublicPath("/Execution/private")).toBe(false);
    expect(isPublicPath("/CaseLogs")).toBe(false);
    expect(isPublicPath("/CaseLog/private")).toBe(false);
  });
});
