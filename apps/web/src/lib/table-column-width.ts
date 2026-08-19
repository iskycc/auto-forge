export type ColumnWidthOptions = {
  coverage?: number;
  minimum: number;
  maximum: number;
};

/**
 * 用覆盖指定比例行的文本长度决定列宽；极少数超长值不再拉宽整列，而是在固定列内换行。
 * 中文等宽字符按两个西文字符估算，结果使用 CSS `ch` 单位。
 */
export function columnCharacterWidthAtCoverage(
  values: readonly string[],
  { coverage = 0.7, minimum, maximum }: ColumnWidthOptions,
): number {
  if (values.length === 0) return minimum;
  const widths = values.map(estimatedCharacterWidth).sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(widths.length * coverage) - 1);
  return Math.min(maximum, Math.max(minimum, widths[index] ?? minimum));
}

export function widestText(values: readonly string[]): string {
  return values.reduce(
    (widest, value) =>
      estimatedCharacterWidth(value) > estimatedCharacterWidth(widest) ? value : widest,
    "",
  );
}

function estimatedCharacterWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width += character.codePointAt(0)! > 0xff ? 2 : 1;
  }
  return width;
}
