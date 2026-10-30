import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { parseDdtUpload, parseSpreadsheet } from "../src";

function spreadsheet(sharedStrings = false) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(
    [
      ["CaseID", "srNum", "中文文本", "数值", "布尔", "日期", "公式", "空值", "错误"],
      [
        "中文-1",
        "SR-1",
        " <tag>& \n😀_x0041_ ",
        12.5,
        true,
        new Date("2026-10-30T08:30:00.000Z"),
        42,
        "",
        "",
      ],
      [
        "中文-2",
        "SR-2",
        "多行\r\n第二行",
        0,
        false,
        new Date("2026-01-02T00:00:00.000Z"),
        0,
        "",
        "",
      ],
    ],
    { cellDates: true },
  );
  sheet.D2!.z = "0000.00";
  sheet.D3!.z = "0.00%";
  sheet.F2!.z = "yyyy-mm-dd hh:mm:ss";
  sheet.F3!.z = "yyyy-mm-dd";
  sheet.G2!.f = "40+2";
  sheet.G3!.f = "1-1";
  sheet.I2 = { t: "e", v: 15 };
  XLSX.utils.book_append_sheet(workbook, sheet, "data");
  return XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    bookSST: sharedStrings,
  }) as Buffer;
}

async function parse(content: Uint8Array) {
  return parseDdtUpload({ fileName: "cases.xlsx", mediaType: "application/octet-stream", content });
}

describe("streaming XLSX imports", () => {
  it.each([false, true])(
    "matches formatted values with shared strings=%s",
    async (sharedStrings) => {
      const content = spreadsheet(sharedStrings);
      const expected = parseSpreadsheet(content, "cases.xlsx");
      const files = await parse(content);
      expect(files[0]!.errorSummary).toBeUndefined();
      expect(files[0]!.rows).toEqual(expected.rows);
    },
  );

  it("preserves an Excel 1904 date system, custom formats and rich shared strings", async () => {
    const entries = unzipSync(spreadsheet(true));
    entries["xl/workbook.xml"] = strToU8(
      strFromU8(entries["xl/workbook.xml"]!).replace(
        /<workbookPr[^>]*\/>/,
        '<workbookPr date1904="1"/>',
      ),
    );
    entries["xl/sharedStrings.xml"] = strToU8(
      strFromU8(entries["xl/sharedStrings.xml"]!).replace(
        "<t>中文-1</t>",
        '<r><t>中文</t></r><r><t>-1</t></r><rPh sb="0" eb="2"><t>zhongwen</t></rPh>',
      ),
    );
    const content = Buffer.from(zipSync(entries));
    const result = await parse(content);
    expect(result[0]!.errorSummary).toBeUndefined();
    expect(result[0]!.rows).toEqual(parseSpreadsheet(content, "cases.xlsx").rows);
  });

  it("reads namespace-prefixed XML in UTF-16 without using worksheet dimensions as allocations", async () => {
    const entries = unzipSync(spreadsheet());
    let xml = strFromU8(entries["xl/worksheets/sheet1.xml"]!);
    xml = xml.replace(/<dimension[^>]*\/>/, '<dimension ref="A1:XFD1048576"/>');
    xml = xml.replace(/<(\/?)(worksheet|sheetData|row|c|v|is|t|f)(?=[\s/>])/g, "<$1m:$2");
    xml = xml.replace(
      'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      'xmlns:m="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    );
    xml = xml.replace('encoding="UTF-8"', 'encoding="UTF-16"');
    entries["xl/worksheets/sheet1.xml"] = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(xml, "utf16le"),
    ]);
    const files = await parse(zipSync(entries));
    expect(files[0]!.errorSummary).toBeUndefined();
    expect(files[0]!.rows).toEqual(parseSpreadsheet(spreadsheet(), "cases.xlsx").rows);
  });

  it("ignores unrelated sheets and resolves parts by relationships regardless of ZIP order", async () => {
    const entries = unzipSync(spreadsheet(true));
    entries["xl/workbook.xml"] = strToU8(
      strFromU8(entries["xl/workbook.xml"]!).replace(
        "</sheets>",
        '<sheet name="说明" sheetId="2" r:id="rIdNotes"/></sheets>',
      ),
    );
    entries["xl/_rels/workbook.xml.rels"] = strToU8(
      strFromU8(entries["xl/_rels/workbook.xml.rels"]!).replace(
        "</Relationships>",
        '<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/notes.xml"/></Relationships>',
      ),
    );
    entries["xl/worksheets/notes.xml"] = strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c><v>999</v></c></row></sheetData></worksheet>',
    );
    const content = zipSync(Object.fromEntries(Object.entries(entries).reverse()));
    const files = await parse(content);
    expect(files[0]!.errorSummary).toBeUndefined();
    expect(files[0]!.rows).toEqual(parseSpreadsheet(spreadsheet(true), "cases.xlsx").rows);
  });

  it("retains logical row order when worksheet XML stores rows out of order", async () => {
    const entries = unzipSync(spreadsheet(true));
    const path = "xl/worksheets/sheet1.xml";
    const xml = strFromU8(entries[path]!);
    const rows = xml.match(/<row\b[\s\S]*?<\/row>/g)!;
    entries[path] = strToU8(
      xml.replace(
        /<sheetData>[\s\S]*?<\/sheetData>/,
        `<sheetData>${rows.reverse().join("")}</sheetData>`,
      ),
    );
    const files = await parse(zipSync(entries));
    expect(files[0]!.errorSummary).toBeUndefined();
    expect(files[0]!.rows).toEqual(parseSpreadsheet(spreadsheet(true), "cases.xlsx").rows);
  });

  it("does not allocate blank columns from formatting or explicit empty strings at XFD", async () => {
    const entries = unzipSync(spreadsheet());
    const path = "xl/worksheets/sheet1.xml";
    entries[path] = strToU8(
      strFromU8(entries[path]!).replace(
        "</sheetData>",
        '<row r="8000"><c r="XFD8000" s="1"/><c r="XFC8000" t="inlineStr"><is><t></t></is></c></row></sheetData>',
      ),
    );
    const files = await parse(zipSync(entries));
    expect(files[0]!.errorSummary).toBeUndefined();
    expect(files[0]!.rows).toEqual(parseSpreadsheet(spreadsheet(), "cases.xlsx").rows);
  });

  it("resolves only referenced shared strings and prunes empty shared-string cells at XFD", async () => {
    const entries = unzipSync(spreadsheet(true));
    const stringsPath = "xl/sharedStrings.xml";
    const xml = strFromU8(entries[stringsPath]!);
    const emptyIndex = (xml.match(/<si>/g) ?? []).length;
    entries[stringsPath] = strToU8(
      xml.replace(
        "</sst>",
        `<si><t></t></si>${"<si><t>不会导入的说明数据</t></si>".repeat(20_000)}</sst>`,
      ),
    );
    const path = "xl/worksheets/sheet1.xml";
    entries[path] = strToU8(
      strFromU8(entries[path]!).replace(
        "</sheetData>",
        `<row r="8000"><c r="XFD8000" t="s"><v>${emptyIndex}</v></c></row></sheetData>`,
      ),
    );
    const files = await parse(zipSync(entries));
    expect(files[0]!.errorSummary).toBeUndefined();
    expect(files[0]!.rows).toEqual(parseSpreadsheet(spreadsheet(true), "cases.xlsx").rows);
  });

  it.each([false, true])(
    "matches built-in number/date formats with date1904=%s",
    async (date1904) => {
      const workbook = XLSX.utils.book_new();
      workbook.Workbook = { WBProps: { date1904 } };
      const sheet = XLSX.utils.aoa_to_sheet([
        ["CaseID", "srNum", "零日期", "闰日", "日期", "科学", "货币", "分数", "超长文本"],
        [
          "格式-1",
          "SR",
          0,
          60,
          45_000.5,
          1.23456789e12,
          -1234.56,
          0.5,
          "中文😀_x0041_".repeat(2900),
        ],
      ]);
      for (const address of ["C2", "D2", "E2"]) sheet[address]!.z = "yyyy-mm-dd hh:mm:ss";
      sheet.F2!.z = "0.00E+00";
      sheet.G2!.z = '"¥"#,##0.00;[Red]-"¥"#,##0.00';
      sheet.H2!.z = "# ?/?";
      XLSX.utils.book_append_sheet(workbook, sheet, "data");
      const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
      const files = await parse(content);
      expect(files[0]!.errorSummary).toBeUndefined();
      expect(files[0]!.rows).toEqual(parseSpreadsheet(content, "cases.xlsx").rows);
    },
  );

  it("uses the same duplicate-column and mixed ordinary/journey rules", async () => {
    const workbook = XLSX.utils.book_new();
    for (const [name, caseId] of [
      ["data", "普通"],
      ["step1", "旅程"],
      ["step2", "旅程"],
    ]) {
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ["CaseID", "srNum", "Owner", "Owner", "empty", "empty"],
          [caseId, "SR", "甲", "乙", "", ""],
        ]),
        name,
      );
    }
    const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const conflicted = await parse(content);
    expect(conflicted[0]!.columnConflicts).toHaveLength(3);
    const resolutions = ["data", "step1", "step2"].map((sheetName) => ({
      sheetName,
      columnIndex: 3,
      resolvedName: "Reviewer",
    }));
    const files = await parseDdtUpload({
      fileName: "cases.xlsx",
      mediaType: "application/octet-stream",
      content,
      columnResolutions: resolutions,
    });
    expect(files[0]!.errorSummary).toBeUndefined();
    expect(files[0]!.rows).toEqual(parseSpreadsheet(content, "cases.xlsx", resolutions).rows);
  });

  it("preserves ISO date cells with a built-in time format", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["CaseID", "srNum", "时间"],
      ["日期-1", "SR", 45000.5],
    ]);
    sheet.C2!.z = "m/d/yy h:mm";
    XLSX.utils.book_append_sheet(workbook, sheet, "data");
    const entries = unzipSync(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
    const path = "xl/worksheets/sheet1.xml";
    entries[path] = strToU8(
      strFromU8(entries[path]!).replace(
        /<c r="C2"([^>]*)><v>[^<]*<\/v><\/c>/,
        '<c r="C2"$1 t="d"><v>2026-10-30T08:30:00.000Z</v></c>',
      ),
    );
    const content = Buffer.from(zipSync(entries));
    const files = await parse(content);
    expect(files[0]!.errorSummary).toBeUndefined();
    expect(files[0]!.rows).toEqual(parseSpreadsheet(content, "cases.xlsx").rows);
    expect(files[0]!.rows[0]!["时间"]).toContain("8:30");
  });

  it("preserves escaped literals in a custom number format", async () => {
    const entries = unzipSync(spreadsheet());
    const path = "xl/styles.xml";
    entries[path] = strToU8(
      strFromU8(entries[path]!).replace(
        'formatCode="0000.00"',
        'formatCode="&quot;_x0059_&quot;0.00"',
      ),
    );
    const content = Buffer.from(zipSync(entries));
    const files = await parse(content);
    expect(files[0]!.errorSummary).toBeUndefined();
    expect(files[0]!.rows).toEqual(parseSpreadsheet(content, "cases.xlsx").rows);
    expect(files[0]!.rows[0]!["数值"]).toBe("Y12.50");
  });

  it.each(["truncated", "doctype", "missing-shared-string", "bad-relationship"])(
    "fails the entire file for %s without returning partial rows",
    async (failure) => {
      const entries = unzipSync(spreadsheet(true));
      const sheetPath = "xl/worksheets/sheet1.xml";
      if (failure === "truncated")
        entries[sheetPath] = entries[sheetPath]!.subarray(0, entries[sheetPath]!.length - 30);
      if (failure === "doctype")
        entries[sheetPath] = strToU8(
          strFromU8(entries[sheetPath]!).replace(
            /<worksheet/,
            '<!DOCTYPE worksheet SYSTEM "https://example.invalid/private"><worksheet',
          ),
        );
      if (failure === "missing-shared-string")
        entries[sheetPath] = strToU8(
          strFromU8(entries[sheetPath]!).replace("<v>0</v>", "<v>9999999</v>"),
        );
      if (failure === "bad-relationship")
        entries["xl/_rels/workbook.xml.rels"] = strToU8(
          strFromU8(entries["xl/_rels/workbook.xml.rels"]!).replace(
            'Target="worksheets/sheet1.xml"',
            'Target="../../outside.xml"',
          ),
        );
      const files = await parse(zipSync(entries));
      expect(files[0]!.errorSummary).toBeTruthy();
      expect(files[0]!.rows).toEqual([]);
    },
  );

  it.each(["checksum", "expanded-size"] as const)(
    "rejects invalid XLSX %s metadata before returning parsed rows",
    async (failure) => {
      const content = Buffer.from(zipSync(unzipSync(spreadsheet())));
      let changed = false;
      for (let offset = 0; offset <= content.length - 46; offset++) {
        if (content.readUInt32LE(offset) !== 0x02014b50) continue;
        const nameLength = content.readUInt16LE(offset + 28);
        const name = content.subarray(offset + 46, offset + 46 + nameLength).toString();
        if (name !== "xl/worksheets/sheet1.xml") continue;
        if (failure === "expanded-size") content.writeUInt32LE(513 * 1024 ** 2, offset + 24);
        else {
          content.writeUInt32LE(0, offset + 16);
          const localHeader = content.readUInt32LE(offset + 42);
          content.writeUInt32LE(0, localHeader + 14);
        }
        changed = true;
        break;
      }
      expect(changed).toBe(true);
      const files = await parse(content);
      expect(files[0]!.rows).toEqual([]);
      expect(files[0]!.errorSummary).toContain(failure === "checksum" ? "校验" : "超过允许上限");
    },
  );
});
