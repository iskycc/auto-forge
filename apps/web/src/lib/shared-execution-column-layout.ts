export const executionCaseColumnWidthsRem = {
  round: 4.875,
  duration: 4.75,
  actions: 17,
  sharedActions: 12,
} as const;

export const minimumCaseNameWidthCh = 22;
const minimumFailureStatusWidthCh = 24;

/** Reserve readable fixed columns; divide the remaining space by visible text demand. */
export function sharedExecutionColumnLayout({
  widths,
  showRoundColumn,
}: {
  widths: { case: number; status: number; runner: number };
  showRoundColumn: boolean;
}) {
  const fixedWidthRem =
    executionCaseColumnWidthsRem.duration +
    executionCaseColumnWidthsRem.sharedActions +
    (showRoundColumn ? executionCaseColumnWidthsRem.round : 0);
  const caseShare = widths.case / (widths.case + widths.status);
  const minimumContentWidthCh =
    minimumCaseNameWidthCh + minimumFailureStatusWidthCh + widths.runner;
  const minimumTableWidth = `max(760px, calc(${fixedWidthRem}rem + ${minimumContentWidthCh}ch))`;
  // Percentages inside calc() do not size fixed-layout table columns. Resolve
  // against the scroll container instead, including its minimum table width.
  const tableWidth = `max(100cqw, ${minimumTableWidth})`;
  const availableWidth = `${tableWidth} - ${fixedWidthRem}rem - ${widths.runner}ch`;
  return {
    // Short names must not expand merely because a wide monitor has spare room.
    caseWidth: `clamp(${minimumCaseNameWidthCh}ch, calc((${availableWidth}) * ${caseShare}), ${widths.case}ch)`,
    minimumTableWidth,
  };
}
