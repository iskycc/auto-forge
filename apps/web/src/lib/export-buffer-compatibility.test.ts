import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("writes and reads a streaming Excel workbook without deprecated Buffer constructors", async () => {
  const excelPath = createRequire(import.meta.url).resolve("exceljs");
  const source = `
    import { createRequire } from 'node:module';
    import { PassThrough } from 'node:stream';
    import assert from 'node:assert/strict';
    const ExcelJS = createRequire(import.meta.url)(${JSON.stringify(excelPath)});
    const stream = new PassThrough();
    const parts = []; stream.on('data', (part) => parts.push(part));
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ stream });
    const sheet = writer.addWorksheet('中文用例');
    sheet.addRow(['CaseID', '结果']).commit();
    sheet.addRow(['支付用例-中文', '失败']).commit();
    sheet.commit(); await writer.commit();
    const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.concat(parts));
    assert.equal(book.getWorksheet('中文用例').getCell('A2').value, '支付用例-中文');
    assert.equal(book.getWorksheet('中文用例').getCell('B2').value, '失败');
    console.log('roundtrip verified');
  `;
  const result = await promisify(execFile)(process.execPath, [
    "--pending-deprecation",
    "--trace-deprecation",
    "--input-type=module",
    "-e",
    source,
  ]);
  expect(result.stdout).toContain("roundtrip verified");
  expect(result.stderr).not.toContain("[DEP0005]");
});
