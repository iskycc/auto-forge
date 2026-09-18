// 制表符优先于逗号：Excel 直接复制产生的是 TSV，只有不含制表符时才按 CSV 处理。
export function firstColumnOf(line: string): string {
  line = line.replace(/^\uFEFF/, "");
  const tab = line.indexOf("\t");
  if (tab !== -1) {
    const cell = line.slice(0, tab);
    return cell.startsWith('"') ? firstCsvCell(cell) : cell;
  }
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
