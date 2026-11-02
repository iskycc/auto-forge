import { expect, it } from "vitest";
import { registrationReturnPath } from "./registration-return-path";

it.each([
  undefined,
  [],
  "https://example.org/",
  "//example.org/",
  "/\\example.org",
  "/\n/evil",
  "/register",
  "/login?login=1",
  "/setup",
  "/landing",
  "/" + "x".repeat(8192),
])("rejects external, invalid and looping registration destinations: %j", (destination) =>
  expect(registrationReturnPath(destination)).toBe("/"),
);

it("returns to the exact business page and anchor without reopening the login dialog", () => {
  expect(registrationReturnPath("/RunTask?SuiteId=suite&login=1&passwordChanged=1#progress")).toBe(
    "/RunTask?SuiteId=suite#progress",
  );
});
