import assert from "node:assert/strict";
import { unzipSync } from "fflate";

// CT_Worksheet uses a sequence, not an unordered set. XML parsers and ExcelJS's
// reader accept the wrong order, while Excel can reject the entire worksheet.
// Source: dotnet/Open-XML-SDK, spreadsheetml CT_Worksheet particle.
const WORKSHEET_FEATURE_ORDER = [
  "sheetProtection",
  "autoFilter",
  "mergeCells",
  "conditionalFormatting",
  "dataValidations",
  "hyperlinks",
  "pageMargins",
  "pageSetup",
  "headerFooter",
  "rowBreaks",
] as const;

export function assertExportedWorksheetFeatureOrder(xml: string, part: string): void {
  let previous = { name: "sheetData", offset: xml.indexOf("<sheetData") };
  assert.ok(previous.offset >= 0, `${part}: worksheet data is missing`);
  for (const name of WORKSHEET_FEATURE_ORDER) {
    const offset = xml.indexOf(`<${name}`);
    if (offset < 0) continue;
    assert.ok(
      offset > previous.offset,
      `${part}: ${name} must follow ${previous.name} in the Open XML worksheet sequence`,
    );
    previous = { name, offset };
  }
}

export function assertExportedWorkbookFeatureOrder(buffer: Uint8Array): void {
  const archive = unzipSync(buffer);
  const sheets = Object.entries(archive).filter(([part]) =>
    /^xl\/worksheets\/sheet\d+\.xml$/u.test(part),
  );
  assert.ok(sheets.length > 0, "Exported workbook has no worksheets");
  for (const [part, bytes] of sheets)
    assertExportedWorksheetFeatureOrder(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      part,
    );
}
