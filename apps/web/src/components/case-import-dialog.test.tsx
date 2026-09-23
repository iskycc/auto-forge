import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CaseImportDialog } from "./case-import-dialog";

it("keeps the import action disabled until its client event handlers are ready", () => {
  const html = renderToStaticMarkup(<CaseImportDialog cases={[]} onImport={() => undefined} />);
  expect(html).toMatch(/<button[^>]+disabled=""/u);
  expect(html).toContain("导入用例");
});
