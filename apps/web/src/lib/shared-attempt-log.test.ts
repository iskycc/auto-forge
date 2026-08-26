import { describe, expect, it } from "vitest";

import {
  SHARED_LOG_MAX_BYTES,
  sharedOutcomeClass,
  sharedOutcomeLabel,
  truncateSharedLogText,
} from "./shared-attempt-log";

describe("truncateSharedLogText", () => {
  it("keeps logs within the byte limit untouched", () => {
    const logText = "INFO started\nERROR boom";
    expect(truncateSharedLogText(logText)).toEqual({ text: logText, truncated: false });
  });

  it("truncates logs beyond the byte limit", () => {
    const logText = "a".repeat(SHARED_LOG_MAX_BYTES + 100);
    const result = truncateSharedLogText(logText);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(SHARED_LOG_MAX_BYTES);
    expect(result.text).toBe("a".repeat(SHARED_LOG_MAX_BYTES));
  });

  it("does not split multi-byte characters at the truncation boundary", () => {
    // 让每个汉字恰好跨在字节上限上：上限处只剩一个残缺字节。
    const logText = "a".repeat(SHARED_LOG_MAX_BYTES - 1) + "汉";
    const result = truncateSharedLogText(logText);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a".repeat(SHARED_LOG_MAX_BYTES - 1));
    expect(result.text).not.toContain("\uFFFD");
  });
});

describe("shared outcome presentation", () => {
  it("maps outcomes to labels and semantic badge classes", () => {
    expect(sharedOutcomeLabel("succeeded")).toBe("通过");
    expect(sharedOutcomeLabel("running")).toBe("执行中");
    expect(sharedOutcomeLabel("timed_out")).toBe("超时");
    expect(sharedOutcomeClass("assigned")).toBe("batch-status-queued");
    expect(sharedOutcomeClass("failed")).toBe("batch-status-failed");
    expect(sharedOutcomeClass("cancelled")).toBe("batch-status-neutral");
  });
});
