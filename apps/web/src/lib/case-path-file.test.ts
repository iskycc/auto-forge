import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { parseCasePathFile } from "./case-path-file";

describe("case path table files", () => {
  it("reads the first column of the first XLSX worksheet without corrupting Chinese", async () => {
    const bytes = minimalXlsx([
      ["用例路径", "备注"],
      ["com/示例/登录用例", "中文内容不会成为路径"],
      ["com/example/CheckoutTest", "smoke"],
    ]);

    await expect(parseCasePathFile(importFile("cases.xlsx", bytes))).resolves.toEqual([
      "com/示例/登录用例",
      "com/example/CheckoutTest",
    ]);
  });

  it("decodes GB18030 CSV exported by Chinese Windows Excel", async () => {
    const bytes = Uint8Array.from([
      0xd3,
      0xc3,
      0xc0,
      0xfd,
      0xc2,
      0xb7,
      0xbe,
      0xb6,
      0x0a,
      ...new TextEncoder().encode("com/example/CheckoutTest\n"),
    ]);

    await expect(parseCasePathFile(importFile("cases.csv", bytes, "text/csv"))).resolves.toEqual([
      "com/example/CheckoutTest",
    ]);
  });

  it("decodes UTF-16LE text with a byte-order mark", async () => {
    const text = "用例路径\ncom/example/CheckoutTest\n";
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      utf16[2 + index * 2] = code & 0xff;
      utf16[3 + index * 2] = code >> 8;
    }

    await expect(parseCasePathFile(importFile("cases.txt", utf16))).resolves.toEqual([
      "com/example/CheckoutTest",
    ]);
  });

  it("reports an actionable error for legacy XLS files", async () => {
    await expect(parseCasePathFile(importFile("cases.xls", Uint8Array.of(1)))).rejects.toThrow(
      "另存为 .xlsx",
    );
  });
});

function importFile(name: string, bytes: Uint8Array, type = ""): File {
  const content = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(content).set(bytes);
  return new File([content], name, { type });
}

function minimalXlsx(rows: string[][]): Uint8Array {
  const sheetRows = rows
    .map(
      (cells, rowIndex) =>
        `<row r="${rowIndex + 1}">${cells
          .map(
            (value, columnIndex) =>
              `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  const encoder = new TextEncoder();
  return zipSync({
    "[Content_Types].xml": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "_rels/.rels": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    "xl/workbook.xml": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Cases" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  });
}

function columnName(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
