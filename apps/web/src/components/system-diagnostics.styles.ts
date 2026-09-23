/** Component compositions using the shared Ant Design theme. */
const styles = {
  page: "system-diagnostics-page grid gap-4 min-w-0 [&_.diagnostic-dead-letters]:min-w-0 [&_.diagnostic-dead-letters_.data-table]:[table-layout:fixed] [&_.diagnostic-dead-letters_.data-table]:w-full [&_.diagnostic-dead-letters_td]:[overflow-wrap:anywhere]",
  toolbar:
    "system-diagnostics-toolbar flex items-center gap-3 min-w-0 justify-between flex-wrap [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:leading-[1.6]",
  actions: "system-diagnostics-actions flex items-center gap-2 min-w-0 flex-wrap",
  overviewHeading:
    "system-diagnostics-overviewHeading flex items-center gap-3 min-w-0 [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:leading-[1.6] [&_h2]:my-1 [&_h2]:mx-0 [&_h2]:text-lg [&_>_.system-diagnostics-badge]:ml-auto",
  panelHeading:
    "system-diagnostics-panelHeading flex items-center gap-2 min-w-0 [&_>_svg]:text-muted-foreground [&_>_svg]:shrink-0 [&_h3]:m-0 [&_h3]:text-sm [&_.system-diagnostics-badge]:ml-auto",
  dependency:
    "system-diagnostics-dependency [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:leading-[1.6] [&_p]:mt-1 [&_p]:[overflow-wrap:anywhere] [&_p]:[display:-webkit-box] [&_p]:[-webkit-box-orient:vertical] [&_p]:[-webkit-line-clamp:3] [&_p]:overflow-hidden [&_small]:text-xs [&_small]:text-muted-foreground [&_small]:font-normal [&_small]:block [&_small]:mt-2 min-w-0 p-4 [&_strong]:block [&_strong]:mt-3 [&_strong]:text-sm",
  note: "system-diagnostics-note m-0 text-muted-foreground text-xs leading-[1.6] mt-3",
  overview: "system-diagnostics-overview p-5",
  badge:
    "system-diagnostics-badge inline-flex items-center rounded-full py-1 px-2 text-xs whitespace-nowrap",
  statusIcon: "system-diagnostics-statusIcon grid place-items-center p-3 rounded-lg shrink-0",
  success: "system-diagnostics-success text-success bg-success/10",
  warning: "system-diagnostics-warning text-warning bg-warning/10",
  danger: "system-diagnostics-danger text-destructive bg-destructive/10",
  info: "system-diagnostics-info text-info bg-info/10",
  summary:
    "system-diagnostics-summary grid grid-cols-3 [margin:16px_0_0] gap-4 border-t border-solid border-border pt-4 [&_>_div]:grid [&_>_div]:gap-1 [&_>_div]:min-w-0 [&_strong]:flex [&_strong]:flex-wrap [&_strong]:items-center [&_strong]:gap-2 [&_strong]:text-lg [&_small]:text-xs [&_small]:text-muted-foreground [&_small]:font-normal [&_strong_span]:text-xs [&_strong_span]:font-normal [&_strong_span]:border-0 [&_strong_span]:p-0 [&_strong_span]:bg-transparent",
  resourceTop:
    "system-diagnostics-resourceTop [&_small]:text-xs [&_small]:text-muted-foreground [&_small]:font-normal grid grid-cols-3 gap-2 my-4 mx-0 [&_>_div]:grid [&_>_div]:gap-2 [&_>_div]:min-w-0 [&_strong]:text-sm",
  queueStats:
    "system-diagnostics-queueStats [&_small]:text-xs [&_small]:text-muted-foreground [&_small]:font-normal [&_>_div]:grid [&_>_div]:gap-2 [&_>_div]:min-w-0 grid grid-cols-3 gap-3 my-4 mx-0 [&_strong]:text-2xl [&_strong]:tabular-nums",
  dependencies:
    "system-diagnostics-dependencies grid grid-cols-4 gap-3 max-[1181px]:grid max-[1181px]:grid-cols-2",
  issues:
    "system-diagnostics-issues [&_h3]:m-0 [&_h3]:text-sm [&_h3]:flex [&_h3]:items-center [&_h3]:gap-2 py-4 px-5 border-l-4 border-solid border-border [&_ul]:[list-style:none] [&_ul]:[margin:12px_0_0] [&_ul]:p-0 [&_li_+_li]:mt-3 [&_p]:m-0 [&_p]:text-sm [&_p]:[overflow-wrap:anywhere] [&_code]:text-muted-foreground [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&_summary]:cursor-pointer [&_summary]:text-info [&_summary]:text-sm [&_summary]:py-2",
  panels:
    "system-diagnostics-panels grid grid-cols-2 gap-4 max-[1181px]:grid-cols-[minmax(0,_1fr)]",
  panel: "system-diagnostics-panel p-5 min-w-0",
  facts:
    "system-diagnostics-facts [margin:16px_0_0] text-sm [&_>_div]:grid [&_>_div]:grid-cols-[7em_minmax(0,_1fr)] [&_>_div]:gap-2 [&_>_div]:py-2 [&_>_div]:px-0 [&_>_div]:border-b [&_>_div]:border-solid [&_>_div]:border-border [&_>_div:last-child]:border-0 [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:text-right [&_dd]:[overflow-wrap:anywhere] [&_dd]:min-w-0 [&_code]:text-xs",
  meter:
    "system-diagnostics-meter mt-3 grid gap-2 [&_>_div:first-child]:flex [&_>_div:first-child]:justify-between [&_>_div:first-child]:flex-wrap [&_>_div:first-child]:gap-1 [&_>_div:first-child]:text-xs [&_small]:text-muted-foreground [&_small]:text-inherit",
  issueSummary:
    "system-diagnostics-issueSummary [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden",
  "diagnostic-dead-letters": "system-diagnostics-diagnostic-dead-letters",
  "data-table": "system-diagnostics-data-table",
} as const;
export default styles;
