/**
 * 性能测试专用模块声明：apps/web 的导出工作簿生成依赖 Next.js 上下文与 server-only
 * 标记包，性能测试通过 vitest.performance.config.ts 的别名直接复用其实现；
 * exceljs 同理只安装在 apps/web，运行时别名到该副本、类型在此收窄为本测试的用法。
 */
declare module "@/export-workbook" {
  import type { RunBatchExportRow } from "../../packages/application/src/export-run-batch-results";

  export type RunBatchExportWorkbookInput = {
    batchId: string;
    scope: "round" | "final";
    round?: number;
    rows: readonly RunBatchExportRow[];
    shareLinks: ReadonlyMap<string, string>;
  };

  export function buildRunBatchExportWorkbook(input: RunBatchExportWorkbookInput): Promise<{
    buffer: Buffer;
    filename: string;
  }>;

  export function exportContentDisposition(filename: string): string;
}

declare module "exceljs" {
  type ExportedCell = {
    text: string;
    value: unknown;
    hyperlink?: string;
    dataValidation: { type?: string };
    fill: { type: "pattern" | "gradient"; fgColor?: { argb?: string } };
  };
  type ExportedRow = {
    values: unknown[];
    getCell(column: number): ExportedCell;
    eachCell(callback: (cell: ExportedCell) => void): void;
  };
  const ExcelJS: {
    Workbook: new () => {
      xlsx: { load(buffer: Uint8Array): Promise<void> };
      worksheets: Array<{
        rowCount: number;
        columnCount: number;
        getRow(row: number): ExportedRow;
        getCell(row: number, column: number): ExportedCell;
        eachRow(callback: (row: ExportedRow, rowNumber: number) => void): void;
      }>;
      getWorksheet(name: string):
        | {
            getCell(reference: string): { value: unknown };
            actualRowCount: number;
          }
        | undefined;
    };
  };
  export default ExcelJS;
}
