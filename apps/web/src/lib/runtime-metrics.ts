type HttpMetric = { count: number; durationMs: number };

const globalMetrics = globalThis as typeof globalThis & {
  __autoforgeHttpMetrics?: Map<string, HttpMetric>;
};

function metrics(): Map<string, HttpMetric> {
  globalMetrics.__autoforgeHttpMetrics ??= new Map();
  return globalMetrics.__autoforgeHttpMetrics;
}

export function recordHttpRequest(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
): void {
  const route = metricRoute(path);
  const statusClass = `${Math.floor(statusCode / 100)}xx`;
  const key = `${safeMethod(method)}|${route}|${statusClass}`;
  const current = metrics().get(key) ?? { count: 0, durationMs: 0 };
  current.count += 1;
  current.durationMs += Math.max(0, Math.round(durationMs));
  metrics().set(key, current);
}

export function httpMetricsText(): string[] {
  const lines = [
    "# TYPE autoforge_http_requests_total counter",
    "# TYPE autoforge_http_request_duration_milliseconds_total counter",
  ];
  for (const [key, value] of [...metrics()].sort(([left], [right]) => left.localeCompare(right))) {
    const [method, route, status] = key.split("|") as [string, string, string];
    const labels = `method="${method}",route="${route}",status="${status}"`;
    lines.push(`autoforge_http_requests_total{${labels}} ${value.count}`);
    lines.push(`autoforge_http_request_duration_milliseconds_total{${labels}} ${value.durationMs}`);
  }
  return lines;
}

function safeMethod(method: string): string {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER";
}

function metricRoute(path: string): string {
  if (!path.startsWith("/api/v1/")) return path === "/" ? "/" : "/page";
  for (const prefix of [
    "/api/v1/runner-agents",
    "/api/v1/run-attempts",
    "/api/v1/run-batches",
    "/api/v1/case-sources",
    "/api/v1/case-definitions",
    "/api/v1/case-suites",
    "/api/v1/runners",
    "/api/v1/analytics",
    "/api/v1/settings",
    "/api/v1/auth",
    "/api/v1/health",
  ]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return `${prefix}/:operation`;
  }
  return "/api/v1/other";
}
