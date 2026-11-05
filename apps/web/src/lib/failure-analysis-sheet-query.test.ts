import { describe, expect, it } from "vitest";
import { analysisSheetQuery, analysisSheetFilterUrl } from "./failure-analysis-sheet-query";
describe("analysis sheet URL scope", () => {
  it("starts with bounded class-path sorting and retains search, sort and direction", () => {
    expect(analysisSheetQuery(new URLSearchParams(), null)).toMatchObject({
      view: "all",
      sort: "class_path",
      limit: 50,
    });
    expect(
      analysisSheetQuery(
        new URLSearchParams({
          sheetView: "mine",
          sheetQuery: "wallet",
          sheetSort: "failure_summary",
          sheetDirection: "desc",
        }),
        "user",
      ),
    ).toMatchObject({
      view: "mine",
      query: "wallet",
      sort: "failure_summary",
      direction: "desc",
      limit: 50,
    });
  });
  it("keeps anonymous users in the public read-only view and rejects invalid sort values", () => {
    expect(analysisSheetQuery(new URLSearchParams({ sheetView: "mine" }), null).view).toBe("all");
    expect(
      analysisSheetQuery(new URLSearchParams({ sheetSort: "sql injection" }), "user").sort,
    ).toBe("class_path");
  });
  it("preserves the published batch and login location while making filters shareable", () => {
    const query = analysisSheetQuery(new URLSearchParams({ sheetQuery: "中文 Wallet" }), "user");
    const url = analysisSheetFilterUrl(
      "http://localhost/CaseAnalysis?BatchId=batch-a&login=1#case",
      query,
    );
    expect(url.searchParams.get("BatchId")).toBe("batch-a");
    expect(url.searchParams.get("login")).toBe("1");
    expect(url.hash).toBe("#case");
    expect(analysisSheetQuery(url.searchParams, "user")).toEqual(query);
  });
});
