import { describe, expect, it, vi } from "vitest";
import {
  MANUAL_STOP_WARNING_STORAGE_KEY,
  rememberManualStopWarning,
  skipManualStopWarning,
} from "./manual-stop-preference";

describe("manual stop warning browser preference", () => {
  it("requires the exact browser preference and defaults to showing the warning", () => {
    for (const value of [null, "false", "broken", "1"])
      expect(skipManualStopWarning({ getItem: () => value })).toBe(false);
    expect(skipManualStopWarning({ getItem: () => "true" })).toBe(true);
  });
  it("persists the acknowledged choice only in its own key", () => {
    const setItem = vi.fn();
    expect(rememberManualStopWarning({ setItem })).toBe(true);
    expect(setItem).toHaveBeenCalledWith(MANUAL_STOP_WARNING_STORAGE_KEY, "true");
  });
  it("keeps confirmation available when browser storage is blocked", () => {
    const blocked = () => {
      throw new Error("storage unavailable");
    };
    expect(skipManualStopWarning({ getItem: blocked })).toBe(false);
    expect(rememberManualStopWarning({ setItem: blocked })).toBe(false);
  });
});
