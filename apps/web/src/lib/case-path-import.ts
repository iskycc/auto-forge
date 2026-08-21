import type { CaseDefinitionWithMethods } from "@autoforge/domain";

export const CASE_PATH_HEADER = "用例路径";

export type CasePathMatchResult = {
  matched: CaseDefinitionWithMethods[];
  unmatched: string[];
};

// 用例路径是用户从包名/目录结构可推导出的稳定标识，用于表格导入时与用例对应。
export function casePathOf(item: CaseDefinitionWithMethods): string {
  return item.directoryPath ? `${item.directoryPath}/${item.displayName}` : item.displayName;
}

// 复制自 Excel 的路径常带首尾斜杠或连续斜杠，匹配前先统一形态。
export function normalizeCasePath(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

export function parseCasePathColumn(text: string): string[] {
  return parseCasePathCells(text.split(/\r?\n/).map((line) => firstColumnOf(line)));
}

export function parseCasePathCells(cells: Iterable<string>): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let firstNonEmptyCell = true;
  for (const rawCell of cells) {
    const cell = cleanCell(rawCell);
    if (!cell) continue;
    // 文件可能在表头前带有空行或 BOM；首个有效单元格仍应识别为表头。
    if (firstNonEmptyCell) {
      firstNonEmptyCell = false;
      if (cell === CASE_PATH_HEADER) continue;
    }
    const normalized = normalizeCasePath(cell);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

// 匹配按规范化后的路径精确比较；同一路径对应多个用例时取第一个，避免重复勾选。
// 每个用例同时按斜杠路径（com/example/CheckoutTest）和点分类名（com.example.CheckoutTest）
// 两种写法索引，用户从包结构或类名复制都能匹配。
export function matchCasePaths(
  cases: CaseDefinitionWithMethods[],
  paths: string[],
): CasePathMatchResult {
  const byPath = new Map<string, CaseDefinitionWithMethods>();
  for (const item of cases) {
    const slashPath = normalizeCasePath(casePathOf(item));
    if (!byPath.has(slashPath)) byPath.set(slashPath, item);
    const dottedClassName = normalizeCasePath(item.className);
    if (dottedClassName && !byPath.has(dottedClassName)) byPath.set(dottedClassName, item);
  }
  const matched: CaseDefinitionWithMethods[] = [];
  const unmatched: string[] = [];
  for (const path of paths) {
    const item = byPath.get(normalizeCasePath(path));
    if (item) matched.push(item);
    else unmatched.push(path);
  }
  return { matched, unmatched };
}

// 制表符优先于逗号：Excel 直接复制产生的是 TSV，只有不含制表符时才按 CSV 处理。
function firstColumnOf(line: string): string {
  const tab = line.indexOf("\t");
  if (tab !== -1) return line.slice(0, tab);
  return firstCsvCell(line);
}

// 引号包裹的单元格内可含逗号，两个连续双引号表示转义。
function firstCsvCell(line: string): string {
  if (!line.startsWith('"')) {
    const comma = line.indexOf(",");
    return comma === -1 ? line : line.slice(0, comma);
  }
  let cell = "";
  for (let index = 1; index < line.length; index += 1) {
    const char = line[index];
    if (char !== '"') {
      cell += char;
      continue;
    }
    if (line[index + 1] === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    break;
  }
  return cell;
}

function cleanCell(cell: string): string {
  let value = cell.replace(/^\uFEFF/, "").trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  return value;
}
