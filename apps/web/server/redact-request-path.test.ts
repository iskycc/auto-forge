import { expect, it } from "vitest";
import { redactRequestPath } from "./redact-request-path";
it("redacts personal DDT read capabilities while preserving ordinary API paths", () => {
  const prefix = "/prefix/api/v1/public/ddt/projects/p/versions/v/stages/s/users/u/debug/";
  expect(redactRequestPath(`${prefix}private-key/case`)).toBe(`${prefix}[REDACTED]/case`);
  expect(redactRequestPath("/api/v1/public/ddt/projects/p/versions/v/stages/s/case")).toBe(
    "/api/v1/public/ddt/projects/p/versions/v/stages/s/case",
  );
});
