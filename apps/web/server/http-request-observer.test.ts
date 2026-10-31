import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { observeHttpRequest } from "./http-request-observer";

describe("HTTP request diagnostics", () => {
  it.each([200, 201, 204, 301, 304])(
    "keeps metrics but does not log successful status %s",
    (statusCode) => {
      const response = Object.assign(new EventEmitter(), { statusCode });
      const record = vi.fn();
      const log = vi.fn();
      observeHttpRequest(
        { method: "GET", url: "/api/v1/runners?token=private" } as IncomingMessage,
        response as ServerResponse,
        "request-1",
        record,
        log,
      );
      response.emit("finish");
      expect(record).toHaveBeenCalledWith("GET", "/api/v1/runners", statusCode, expect.any(Number));
      expect(log).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, "warn"],
    [401, "warn"],
    [404, "warn"],
    [429, "warn"],
    [500, "error"],
    [503, "error"],
  ] as const)("logs status %s at %s severity without query parameters", (statusCode, level) => {
    const response = Object.assign(new EventEmitter(), { statusCode });
    const log = vi.fn();
    observeHttpRequest(
      { method: "POST", url: "/api/v1/ddt/import?password=private" } as IncomingMessage,
      response as ServerResponse,
      "request-2",
      vi.fn(),
      log,
    );
    response.emit("finish");
    expect(log).toHaveBeenCalledExactlyOnceWith(level, "HTTP request completed", {
      requestId: "request-2",
      method: "POST",
      path: "/api/v1/ddt/import",
      statusCode,
      durationMs: expect.any(Number),
    });
  });

  it("handles malformed request targets without throwing from the finish listener", () => {
    const response = Object.assign(new EventEmitter(), { statusCode: 400 });
    const record = vi.fn();
    const log = vi.fn();
    observeHttpRequest(
      { method: "GET", url: "http://[invalid?token=secret" } as IncomingMessage,
      response as ServerResponse,
      "invalid-request",
      record,
      log,
    );
    expect(() => response.emit("finish")).not.toThrow();
    expect(log.mock.calls[0]?.[2].path).toBe("/[invalid-request-target]");
  });
});
