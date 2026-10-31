import * as XLSX from "xlsx";
import {
  DDT_ASSOCIATION_IMPORT_ISSUE_LIMIT,
  DDT_ASSOCIATION_IMPORT_MAXIMUM_BYTES,
  DDT_ASSOCIATION_IMPORT_MAXIMUM_ROWS,
  DDT_ASSOCIATION_SHEETS,
  ddtAssociationImportRowSchema,
  type DdtAssociationSection,
  type ParsedDdtAssociationImport,
  type DdtAssociationImportIssue,
} from "@autoforge/contracts";
import { openSpreadsheetZip } from "./archive";

/** Configuration workbooks are narrow; parsing stays in the bounded file worker. */
export async function parseDdtAssociationSpreadsheet(
  content: Uint8Array,
  fileName: string,
): Promise<ParsedDdtAssociationImport> {
  if (!fileName.toLocaleLowerCase("en-US").endsWith(".xlsx"))
    throw new Error("SR 关联配置请使用导出的 XLSX 多工作表文件。");
  if (content.byteLength > DDT_ASSOCIATION_IMPORT_MAXIMUM_BYTES)
    throw new Error("SR 关联配置文件不能超过 16 MiB。");
  const archive = openSpreadsheetZip(content, {
    maximumEntries: 10_000,
    maximumExpandedBytes: 256 * 1024 * 1024,
  });
  // Validate actual inflation and CRC before SheetJS sees the workbook. This avoids trusting
  // forged ZIP sizes or expanding unrelated worksheets as part of configuration parsing.
  for (const path of archive.paths()) {
    let tail = "";
    for await (const chunk of archive.readChunks(path)) {
      if (!path.endsWith(".xml") && !path.endsWith(".rels")) continue;
      const text = (tail + chunk.toString("latin1")).toUpperCase();
      if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY") || text.includes("\0"))
        throw new Error("配置 XLSX 的 XML 不支持 DTD、实体定义或 UTF-16/32 编码。");
      tail = text.slice(-16);
    }
  }
  const bytes = Buffer.from(content);
  const catalog = XLSX.read(bytes, { type: "buffer", bookSheets: true });
  const definitions = Object.entries(DDT_ASSOCIATION_SHEETS) as Array<
    [DdtAssociationSection, { name: string; headers: readonly string[] }]
  >;
  const normalize = (name: string) => name.trim().toLocaleLowerCase("en-US");
  const selected = catalog.SheetNames.filter((name) =>
    definitions.some(([, definition]) => normalize(definition.name) === normalize(name)),
  );
  if (catalog.SheetNames.some((name) => !selected.includes(name) && normalize(name) !== "说明"))
    throw new Error("存在模板以外的工作表，请保留四个配置工作表和说明，避免遗漏数据。 ");
  if (!selected.length)
    throw new Error(
      "没有找到候选测试类／分类执行类／SR需求分类／SR直接关联工作表，请使用关联配置模板，不是 DDT 用例表格。",
    );
  const workbook = XLSX.read(bytes, {
    type: "buffer",
    dense: true,
    cellHTML: false,
    sheets: selected,
    sheetRows: DDT_ASSOCIATION_IMPORT_MAXIMUM_ROWS + 2,
  });
  const parsed: ParsedDdtAssociationImport = { rows: [], rowCount: 0, issueCount: 0, issues: [] };
  const issue = (value: DdtAssociationImportIssue) => {
    parsed.issueCount++;
    if (parsed.issues.length < DDT_ASSOCIATION_IMPORT_ISSUE_LIMIT) parsed.issues.push(value);
  };
  const seen = new Map<string, string>();
  const seenSheets = new Set<DdtAssociationSection>();
  let characters = 0;
  for (const sheetName of selected) {
    const [section, definition] = definitions.find(
      ([, item]) => normalize(item.name) === normalize(sheetName),
    )!;
    if (seenSheets.has(section)) throw new Error(`重复的配置工作表：${sheetName}`);
    seenSheets.add(section);
    const sheet = workbook.Sheets[sheetName]!;
    const cells = (sheet as XLSX.WorkSheet & { "!data"?: XLSX.CellObject[][] })["!data"] ?? [];
    const text = (row: number, column: number) => {
      const cell = cells[row]?.[column];
      return cell
        ? String(cell.w ?? XLSX.utils.format_cell(cell))
            .replace(/^\uFEFF/u, "")
            .trim()
        : "";
    };
    const source = { sheetName, rowNumber: 1, identifier: "" };
    if (
      definition.headers
        .slice(0, -1)
        .some((header, column) => normalize(text(0, column)) !== normalize(header))
    ) {
      issue({
        ...source,
        reason: `第一行需保留表头：${definition.headers.slice(0, -1).join("、")}。`,
      });
      continue;
    }
    if (
      sheet["!fullref"] &&
      XLSX.utils.decode_range(sheet["!fullref"]).e.r > DDT_ASSOCIATION_IMPORT_MAXIMUM_ROWS
    )
      throw new Error("工作表行数超过配置导入预算，请分批导入。");
    for (const rowIndex of Object.keys(cells)
      .map(Number)
      .sort((left, right) => left - right)) {
      if (rowIndex === 0) continue;
      const columns = Object.keys(cells[rowIndex] ?? [])
        .map(Number)
        .filter((column) => text(rowIndex, column) || cells[rowIndex]?.[column]?.f);
      if (!columns.length) continue;
      if (++parsed.rowCount > DDT_ASSOCIATION_IMPORT_MAXIMUM_ROWS)
        throw new Error("每次最多导入 500,000 行关联配置，请分批导入。");
      const first = text(rowIndex, 0),
        second = text(rowIndex, 1);
      const location = { sheetName, rowNumber: rowIndex + 1, identifier: first.slice(0, 1024) };
      const warning = text(rowIndex, definition.headers.length - 1);
      if (
        columns.some(
          (column) => cells[rowIndex]?.[column]?.f || column >= definition.headers.length,
        ) ||
        warning
      ) {
        issue({
          ...location,
          reason: warning
            ? `请先处理并清空“异常说明”：${warning.slice(0, 500)}`
            : "配置仅支持模板列和固定值，不支持公式或额外数据列。",
        });
        continue;
      }
      const candidate =
        section === "range"
          ? { section, className: first }
          : section === "categories"
            ? { section, categoryName: first, className: second }
            : section === "srCategories"
              ? { section, srNum: first, categoryName: second }
              : { section, srNum: first, className: second };
      const validated = ddtAssociationImportRowSchema.safeParse({ ...candidate, ...location });
      if (!validated.success || /[\u0000-\u001f\u007f]/u.test(first + second)) {
        issue({
          ...location,
          reason:
            "必填项缺失、文本过长或包含控制字符；SR 最多 512 字符、分类最多 160 字符、测试类路径最多 1024 字符。",
        });
        continue;
      }
      const key = JSON.stringify([
        section.startsWith("sr") ? "sr" : section,
        section === "range" ? first : normalize(first),
      ]);
      if (seen.has(key)) {
        issue({
          ...location,
          reason: `同一配置重复或 SR 同时出现于两个关联工作表，首次位于 ${seen.get(key)}。`,
        });
        continue;
      }
      seen.set(key, `${sheetName} 第 ${rowIndex + 1} 行`);
      characters += first.length + second.length;
      if (characters > 64 * 1024 * 1024) throw new Error("配置有效文本超过 64 MiB，请分批导入。");
      parsed.rows.push(validated.data);
    }
  }
  if (!parsed.rowCount && !parsed.issueCount)
    issue({
      sheetName: selected[0]!,
      rowNumber: 1,
      identifier: "",
      reason: "表格只有表头，请填写要导入的关联配置。",
    });
  return parsed;
}
