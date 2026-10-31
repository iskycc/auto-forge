import type { IncomingMessage, ServerResponse } from "node:http";

type RequestDiagnostic = {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
};
type RequestRecorder = (
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
) => void;
type RequestLogger = (level: "warn" | "error", message: string, fields: RequestDiagnostic) => void;

/** Metrics retain all traffic; container output is reserved for unsuccessful requests. */
export function observeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  record: RequestRecorder,
  log: RequestLogger,
): void {
  const startedAt = performance.now();
  response.once("finish", () => {
    const method = request.method ?? "OTHER";
    const path = requestPath(request.url);
    const statusCode = response.statusCode;
    const durationMs = Math.round(performance.now() - startedAt);
    record(method, path, statusCode, durationMs);
    if (statusCode < 400) return;
    log(statusCode >= 500 ? "error" : "warn", "HTTP request completed", {
      requestId,
      method,
      path,
      statusCode,
      durationMs,
    });
  });
}

function requestPath(target: string | undefined): string {
  try {
    return new URL(target ?? "/", "http://localhost").pathname;
  } catch {
    // Invalid targets must not crash the server from an asynchronous finish callback.
    return "/[invalid-request-target]";
  }
}
