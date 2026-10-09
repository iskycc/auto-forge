import { createRequire } from "node:module";
import { resolve } from "node:path";

// Use the Web workspace's locked offline dependency and inspect cell values across XLSX encodings.
const ExcelJS = createRequire(resolve(import.meta.dirname, "../../../apps/web/package.json"))(
  "exceljs",
) as typeof import("exceljs").default;

export async function readExportedWorkbookText(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS 4's Buffer declaration predates Node 24; its reader accepts Uint8Array.
  const load = workbook.xlsx.load.bind(workbook.xlsx) as unknown as (
    bytes: Uint8Array,
  ) => Promise<InstanceType<typeof ExcelJS.Workbook>>;
  await load(buffer);
  const values: string[] = [];
  for (const sheet of workbook.worksheets)
    sheet.eachRow((row) => row.eachCell((cell) => values.push(cell.text)));
  return values.join("\n");
}
