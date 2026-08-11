import { describe, expect, it } from "vitest";

import { httpMetricsText, recordHttpRequest } from "./runtime-metrics";

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
