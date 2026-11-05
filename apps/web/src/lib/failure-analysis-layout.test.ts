import { describe, expect, it } from "vitest";
import { analysisWorkspaceLayout } from "./failure-analysis-layout";
describe("analysis workspace layout", () => {
  it.each(["", "view=invalid"])("defaults %s to the spreadsheet", (query) =>
    expect(analysisWorkspaceLayout(new URLSearchParams(query))).toBe("sheet"),
  );
  it.each(["view=claim", "view=workbench", "layout=classic"])(
    "retains the classic %s deep link",
    (query) => expect(analysisWorkspaceLayout(new URLSearchParams(query))).toBe("classic"),
  );
  it("keeps an explicit spreadsheet selection after visiting the old workbench", () =>
    expect(analysisWorkspaceLayout(new URLSearchParams("layout=sheet&view=workbench"))).toBe(
      "sheet",
    ));
});
