import { expect, it } from "vitest";
import {
  authenticationDestination,
  authenticationReturnPath,
  loginPath,
  passwordChangePath,
} from "./authentication-return-path";

it.each([
  undefined,
  [],
  "https://example.org/",
  "//example.org/",
  "/\\example.org",
  "/\n/evil",
  "/register",
  "/register/",
  "/login?login=1",
  "/setup",
  "/landing",
  "/" + "x".repeat(8192),
  "/a/..//example.org",
  "/%2e%2e//example.org",
])("rejects external, invalid and looping authentication destinations: %j", (destination) => {
  expect(authenticationReturnPath(destination)).toBe("/");
});

it("retains the business query and anchor without reopening authentication or requesting an RSC payload", () => {
  expect(
    authenticationReturnPath(
      "/CaseLog?ExecutionId=attempt&login=1&passwordChanged=1&_rsc=cache#log",
    ),
  ).toBe("/CaseLog?ExecutionId=attempt#log");
});

it.each(["/register", "/login", "/account/security", "/?login=1"])(
  "carries a stored destination through %s",
  (entry) => {
    const url = new URL(entry, "http://platform.local");
    url.searchParams.set("returnTo", "/RunTask?SuiteId=suite#controls");
    expect(authenticationDestination(url)).toBe("/RunTask?SuiteId=suite#controls");
  },
);

it("recovers fragments inherited through server redirects without replacing an explicit anchor", () => {
  const url = new URL(
    "http://platform.local/?login=1&returnTo=%2Fexecution-records%3Fkind%3Dsingle#history",
  );
  expect(authenticationDestination(url)).toBe("/execution-records?kind=single#history");
  url.searchParams.set("returnTo", "/execution-records#explicit");
  expect(authenticationDestination(url)).toBe("/execution-records#explicit");
});

it("preserves business parameters named returnTo when a public page opens its login dialog", () => {
  const url = new URL(
    "http://platform.local/RunTask?SuiteId=suite&returnTo=business&login=1#controls",
  );
  expect(authenticationDestination(url)).toBe("/RunTask?SuiteId=suite&returnTo=business#controls");
});

it("keeps tab destinations independent and rejects an external stored destination", () => {
  expect(
    authenticationDestination(
      new URL("http://platform.local/register?returnTo=%2FCaseLog%3FExecutionId%3DA"),
    ),
  ).toBe("/CaseLog?ExecutionId=A");
  expect(
    authenticationDestination(
      new URL("http://platform.local/register?returnTo=%2FCaseLog%3FExecutionId%3DB"),
    ),
  ).toBe("/CaseLog?ExecutionId=B");
  expect(
    authenticationDestination(
      new URL("http://platform.local/register?returnTo=https%3A%2F%2Fevil.test"),
    ),
  ).toBe("/");
});

it("builds login and mandatory password-change links from the same safe destination", () => {
  const destination = "/execution-records?kind=single#history";
  const login = new URL(loginPath(destination, { passwordChanged: true }), "http://platform.local");
  expect(login.searchParams.get("returnTo")).toBe(destination);
  expect(login.searchParams.get("passwordChanged")).toBe("1");
  expect(new URL(passwordChangePath(destination), login).searchParams.get("returnTo")).toBe(
    destination,
  );
  expect(loginPath("https://evil.test")).toBe("/login");
  expect(passwordChangePath("/account/security")).toBe("/account/security");
});
