import { describe, expect, it } from "vitest";

import { matchRunnerFastPath } from "./runner-fast-path";

describe("runner fast path matching", () => {
  it("matches the three hot runner protocol endpoints", () => {
    expect(matchRunnerFastPath("POST", "/api/v1/run-attempts/attempt-1/complete")).toEqual({
      kind: "complete",
      attemptId: "attempt-1",
    });
    expect(matchRunnerFastPath("POST", "/api/v1/run-attempts/attempt-2/logs")).toEqual({
      kind: "logs",
      attemptId: "attempt-2",
    });
    expect(matchRunnerFastPath("POST", "/api/v1/runner-agents/runner-9/claims")).toEqual({
      kind: "claims",
      runnerId: "runner-9",
    });
  });

  it("ignores other methods, paths and nested segments", () => {
    expect(matchRunnerFastPath("GET", "/api/v1/run-attempts/attempt-1/complete")).toBeNull();
    expect(matchRunnerFastPath("POST", "/api/v1/run-attempts/attempt-1/log-share")).toBeNull();
    expect(matchRunnerFastPath("POST", "/api/v1/run-attempts/attempt-1/complete/extra")).toBeNull();
    expect(matchRunnerFastPath("POST", "/api/v1/runner-agents/runner-9/heartbeat")).toBeNull();
    expect(matchRunnerFastPath("POST", undefined)).toBeNull();
  });

  it("keeps query strings from breaking the match", () => {
    expect(matchRunnerFastPath("POST", "/api/v1/run-attempts/attempt-1/complete?trace=1")).toEqual({
      kind: "complete",
      attemptId: "attempt-1",
    });
  });

  it("decodes percent-encoded segments and rejects invalid encodings", () => {
    expect(matchRunnerFastPath("POST", "/api/v1/run-attempts/a%20b/logs")).toEqual({
      kind: "logs",
      attemptId: "a b",
    });
    expect(matchRunnerFastPath("POST", "/api/v1/run-attempts/%zz/complete")).toBeNull();
  });
});
