import { describe, expect, it } from "vitest";

import {
  localDateTimeInputValue,
  refreshQueryFromFilter,
  RUN_BATCH_PAGE_SIZE_OPTIONS,
  runBatchFilterFromSearch,
} from "./run-batch-filter";

describe("runBatchFilterFromSearch", () => {
  it("accepts only the supported page sizes", () => {
    for (const size of RUN_BATCH_PAGE_SIZE_OPTIONS) {
      expect(runBatchFilterFromSearch({ limit: String(size) }, undefined).limit).toBe(size);
    }
  });

  it("falls back to the default page size for missing or unsupported values", () => {
    expect(runBatchFilterFromSearch({}, undefined).limit).toBe(50);
    expect(runBatchFilterFromSearch({ limit: "25" }, undefined).limit).toBe(50);
    expect(runBatchFilterFromSearch({ limit: "0" }, undefined).limit).toBe(50);
    expect(runBatchFilterFromSearch({ limit: "not-a-number" }, undefined).limit).toBe(50);
  });

  it("keeps the page size in the refresh query so pagination survives reloads", () => {
    const filter = runBatchFilterFromSearch({ limit: "100", status: "failed" }, undefined);
    const query = refreshQueryFromFilter(filter);
    expect(query.get("limit")).toBe("100");
    expect(query.get("status")).toBe("failed");
  });

  it("parses and renders date filters in the configured platform time zone", () => {
    const filter = runBatchFilterFromSearch(
      { createdAfter: "2026-08-26T08:30" },
      undefined,
      "Asia/Shanghai",
    );

    expect(filter.createdAfter).toBe("2026-08-26T00:30:00.000Z");
    expect(localDateTimeInputValue(filter.createdAfter, "America/New_York")).toBe(
      "2026-08-25T20:30",
    );
  });
});
