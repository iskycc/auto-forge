export const executionCaseColumnWidthsRem = {
  round: 4.875,
  duration: 4.75,
  actions: 17,
  sharedActions: 12,
} as const;

export const minimumCaseNameWidthCh = 22;
const minimumFailureStatusWidthCh = 24;

/** Reserve readable fixed columns; divide the remaining space by visible text demand. */
export function executionCaseColumnLayout({
  widths,
  showRoundColumn,
  access,
}: {
  widths: { case: number; status: number; runner: number };
  showRoundColumn: boolean;
  access: "console" | "public";
}) {
  const actionsWidthRem =
    access === "public"
      ? executionCaseColumnWidthsRem.sharedActions
      : executionCaseColumnWidthsRem.actions;
  const fixedWidthRem =
    executionCaseColumnWidthsRem.duration +
    actionsWidthRem +
    (showRoundColumn ? executionCaseColumnWidthsRem.round : 0);
  const caseShare = widths.case / (widths.case + widths.status);
  const minimumStatusWidthCh = Math.min(widths.status, minimumFailureStatusWidthCh);
  const minimumContentWidthCh = minimumCaseNameWidthCh + minimumStatusWidthCh + widths.runner;
  const minimumTableWidth = `max(760px, calc(${fixedWidthRem}rem + ${minimumContentWidthCh}ch))`;
  // Percentages inside calc() do not size fixed-layout table columns. Resolve
  // against the scroll container instead, including its minimum table width.
  const tableWidth = `max(100cqw, ${minimumTableWidth})`;
  const availableWidth = `${tableWidth} - ${fixedWidthRem}rem - ${widths.runner}ch`;
  // Both text columns share the same budget. Capping only the case column and
  // leaving status unspecified lets even a short result absorb all spare room.
  const caseWidth = `clamp(${minimumCaseNameWidthCh}ch, calc((${availableWidth}) * ${caseShare}), calc(${availableWidth} - ${minimumStatusWidthCh}ch))`;
  return {
    caseWidth,
    statusWidth: `calc(${availableWidth} - ${caseWidth})`,
    actionsWidth: `${actionsWidthRem}rem`,
    minimumTableWidth,
  };
}
