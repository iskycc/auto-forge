import { describe, expect, it } from "vitest";

import {
  formatPlatformDateTime,
  platformDateTimeInputToIso,
  platformDateTimeInputValue,
  platformDateTimeParameterToIso,
} from "./platform-date-time";

describe("platform date time", () => {
  it("defaults display and local input conversion to UTC+8", () => {
    expect(
      formatPlatformDateTime("2026-08-26T00:30:00.000Z", "Asia/Shanghai", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    ).toContain("2026/08/26 08:30");
    expect(platformDateTimeInputToIso("2026-08-26T08:30", "Asia/Shanghai")).toBe(
      "2026-08-26T00:30:00.000Z",
    );
  });

  it("uses daylight-saving offsets from the selected IANA zone", () => {
    expect(platformDateTimeInputToIso("2026-07-15T08:30", "America/New_York")).toBe(
      "2026-07-15T12:30:00.000Z",
    );
    expect(platformDateTimeInputValue("2026-07-15T12:30:00.000Z", "America/New_York")).toBe(
      "2026-07-15T08:30",
    );
  });

  it("rejects nonexistent wall-clock values and preserves explicit ISO instants", () => {
    expect(platformDateTimeInputToIso("2026-03-08T02:30", "America/New_York")).toBeUndefined();
    expect(platformDateTimeParameterToIso("2026-08-26T00:30:00.000Z", "Asia/Shanghai")).toBe(
      "2026-08-26T00:30:00.000Z",
    );
  });
});
