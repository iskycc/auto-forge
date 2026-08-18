import { describe, expect, it } from "vitest";

import {
  buildRunBatchExportQuery,
  DEFAULT_EXPORT_OUTCOMES,
  EXPORT_FALLBACK_FILENAME,
  parseExportFilename,
} from "./run-batch-export";

describe("buildRunBatchExportQuery", () => {
  it("assembles round scope with the round number and outcomes in contract order", () => {
    const query = buildRunBatchExportQuery("round", 2, ["cancelled", "failed"]);
    const parameters = new URLSearchParams(query);
    expect(parameters.get("scope")).toBe("round");
    expect(parameters.get("round")).toBe("2");
    expect(parameters.get("outcomes")).toBe("failed,cancelled");
  });

  it("omits the round parameter for final scope", () => {
    const query = buildRunBatchExportQuery("final", 3, ["succeeded"]);
    const parameters = new URLSearchParams(query);
    expect(parameters.get("scope")).toBe("final");
    expect(parameters.get("round")).toBeNull();
    expect(parameters.get("outcomes")).toBe("succeeded");
  });

  it("omits the round parameter for all scope", () => {
    const query = buildRunBatchExportQuery("all", undefined, ["succeeded", "blocked"]);
    const parameters = new URLSearchParams(query);
    expect(parameters.get("scope")).toBe("all");
    expect(parameters.get("round")).toBeNull();
    expect(parameters.get("outcomes")).toBe("succeeded,blocked");
  });

  it("keeps every outcome when all are selected", () => {
    const query = buildRunBatchExportQuery("round", 1, [
      "blocked",
      "timed_out",
      "succeeded",
      "cancelled",
      "failed",
    ]);
    expect(new URLSearchParams(query).get("outcomes")).toBe(
      "succeeded,failed,timed_out,cancelled,blocked",
    );
  });

  it("defaults to failed and blocked outcomes", () => {
    expect(DEFAULT_EXPORT_OUTCOMES).toEqual(["failed", "blocked"]);
  });
});

describe("parseExportFilename", () => {
  it("falls back when the header is missing", () => {
    expect(parseExportFilename(null)).toBe(EXPORT_FALLBACK_FILENAME);
  });

  it("parses a plain quoted filename", () => {
    expect(parseExportFilename('attachment; filename="results.xlsx"')).toBe("results.xlsx");
  });

  it("prefers and decodes the RFC 5987 filename* parameter", () => {
    expect(
      parseExportFilename(
        "attachment; filename=\"fallback.xlsx\"; filename*=UTF-8''%E6%89%A7%E8%A1%8C%E7%BB%93%E6%9E%9C.xlsx",
      ),
    ).toBe("执行结果.xlsx");
  });

  it("falls back when filename* cannot be decoded", () => {
    expect(parseExportFilename("attachment; filename*=UTF-8''%E0%A4%A")).toBe(
      EXPORT_FALLBACK_FILENAME,
    );
  });
});
