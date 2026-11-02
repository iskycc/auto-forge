import { describe, expect, it } from "vitest";

import {
  httpMetricsText,
  recordHttpRequest,
  httpTrafficSnapshot,
  recordRuntimeSample,
} from "./runtime-metrics";

describe("runtime HTTP metrics", () => {
  it("bounds route, method and status labels while accumulating duration", () => {
    const identifier = `metric-test-${Date.now()}`;
    recordHttpRequest("GET", `/api/v1/run-batches/${identifier}`, 200, 4.4);
    recordHttpRequest("TRACE", `/api/v1/run-batches/${identifier}`, 503, -10);

    const output = httpMetricsText().join("\n");
    expect(output).toContain(
      'autoforge_http_requests_total{method="GET",route="/api/v1/run-batches/:operation",status="2xx"}',
    );
    expect(output).toContain(
      'autoforge_http_request_duration_milliseconds_total{method="GET",route="/api/v1/run-batches/:operation",status="2xx"}',
    );
    expect(output).toContain(
      'autoforge_http_requests_total{method="OTHER",route="/api/v1/run-batches/:operation",status="5xx"}',
    );
    expect(output).not.toContain(identifier);
  });
});

it("aggregates traffic without per-route scans and returns detached resource samples", () => {
  const before = httpTrafficSnapshot();
  recordHttpRequest("POST", "/sensitive-path", 201, 12);
  recordHttpRequest("GET", "/private", 401, 6);
  recordHttpRequest("GET", "/private", 503, 9);
  recordRuntimeSample(0.25, 4.5);
  const snapshot = httpTrafficSnapshot();
  expect(snapshot.requests).toBe(before.requests + 3);
  expect(snapshot.clientErrors).toBe(before.clientErrors + 1);
  expect(snapshot.serverErrors).toBe(before.serverErrors + 1);
  expect(snapshot.sample).toMatchObject({ cpuUtilizationPercent: 25, eventLoopDelayMs: 4.5 });
  snapshot.sample!.cpuUtilizationPercent = 99;
  expect(httpTrafficSnapshot().sample!.cpuUtilizationPercent).toBe(25);
  expect(JSON.stringify(snapshot)).not.toContain("private");
  recordRuntimeSample(Number.NaN, Infinity);
  expect(httpTrafficSnapshot().sample).toMatchObject({
    cpuUtilizationPercent: 0,
    eventLoopDelayMs: 0,
  });
});
