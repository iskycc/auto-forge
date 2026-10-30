import { createHash } from "node:crypto";
import { zipSync } from "fflate";

export const LARGE_DDT_ROW_COUNT = 8_100;
export const LARGE_DDT_FIELD_COUNT = 48;

export function largeDdtValue(rowIndex: number, columnIndex: number): string {
  if (columnIndex === 0) return `中文用例-${rowIndex}`;
  if (columnIndex === 1) return `SR-${rowIndex % 100}`;
  const digest = createHash("sha256").update(String(rowIndex)).digest("hex");
  return `测试数据-${digest}-${columnIndex}`;
}

/** Rich text is common in edited Excel files and must not become an HTML copy in memory. */
export function largeDdtSpreadsheet(): Uint8Array {
  const columns = Array.from({ length: LARGE_DDT_FIELD_COUNT }, (_, index) =>
    index === 0 ? "CaseID" : index === 1 ? "srNum" : `参数${index}`,
  );
  const rows = [
    `<row>${columns.map((name) => `<c t="inlineStr"><is><t>${name}</t></is></c>`).join("")}</row>`,
  ];
  for (let rowIndex = 0; rowIndex < LARGE_DDT_ROW_COUNT; rowIndex++) {
    rows.push(
      `<row>${columns
        .map(
          (_, columnIndex) =>
            `<c t="inlineStr"><is><r><rPr><b/></rPr><t>${largeDdtValue(rowIndex, columnIndex)}</t></r></is></c>`,
        )
        .join("")}</row>`,
    );
  }
  const encode = (value: string) => new TextEncoder().encode(value);
  return zipSync({
    "[Content_Types].xml": encode(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "_rels/.rels": encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    "xl/workbook.xml": encode(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": encode(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`,
    ),
  });
}
