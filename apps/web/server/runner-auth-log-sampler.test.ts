import { expect, it } from "vitest";
import { RunnerAuthLogSampler } from "./runner-auth-log-sampler";

it("logs the first rejected contact and summarizes repeats across heartbeat/claim routes", () => {
  let now = 1000;
  const sampler = new RunnerAuthLogSampler(() => now);
  const root = "/api/v1/runner-agents/deleted-runner";
  expect(sampler.sample(root + "/heartbeat", 401)).toEqual({});
  for (let index = 0; index < 50; index++) expect(sampler.sample(root + "/claims", 401)).toBeNull();
  now += 60_000;
  expect(sampler.sample(root + "/heartbeat", 401)).toEqual({ suppressedRequests: 50 });
  expect(sampler.sample(root + "/heartbeat", 500)).toEqual({});
  expect(sampler.sample("/api/v1/auth/login", 401)).toEqual({});
  expect(sampler.sample("/api/v1/ddt/import", 401)).toEqual({});
});
it("bounds unique rejected identities without hiding server errors", () => {
  let now = 0;
  const sampler = new RunnerAuthLogSampler(() => now, 60_000, 2);
  expect(sampler.sample("/api/v1/runner-agents/one/heartbeat", 401)).toEqual({});
  expect(sampler.sample("/api/v1/runner-agents/two/heartbeat", 401)).toEqual({});
  expect(sampler.sample("/api/v1/runner-agents/three/heartbeat", 401)).toBeNull();
  expect(sampler.sample("/api/v1/runner-agents/three/heartbeat", 503)).toEqual({});
  now += 60_000;
  expect(sampler.sample("/api/v1/runner-agents/three/heartbeat", 401)).toEqual({});
});

it("coalesces rejected spool uploads using the claimed Runner header without touching ordinary requests", () => {
  const sampler = new RunnerAuthLogSampler(() => 0);
  expect(sampler.sample("/api/v1/runner-agents/deleted/heartbeat", 401)).toEqual({});
  expect(sampler.sample("/api/v1/run-attempts/attempt/logs", 401, "deleted")).toBeNull();
  expect(sampler.sample("/api/v1/run-attempts/attempt/complete", 401, "deleted")).toBeNull();
  expect(sampler.sample("/api/v1/run-attempts/attempt/logs", 401)).toEqual({});
  expect(sampler.sample("/api/v1/auth/login", 401, "deleted")).toEqual({});
});
