export const analysisPageStyles = {
  "analysis-status":
    "inline-flex max-w-full [flex:0_0_auto] flex-wrap items-center gap-[5px] py-[3px] px-[7px] rounded-full bg-muted text-muted-foreground text-xs font-semibold [&.available]:bg-info/10 [&.available]:text-info [&.claimed]:bg-warning/10 [&.claimed]:text-warning [&.analyzing]:bg-info/10 [&.analyzing]:text-info [&.completed]:bg-success/10 [&.completed]:text-success [&_small]:overflow-hidden [&_small]:max-w-full [&_small]:text-inherit! [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
  "case-scope-current":
    "[&_>_span]:flex [&_>_span]:min-w-0 [&_>_span]:gap-2 [&_>_span]:border-l [&_>_span]:border-solid [&_>_span]:border-border [&_>_span]:pl-3.5 [&_>_span]:items-center [&_small]:text-muted-foreground [&_small]:shrink-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:[overflow-wrap:anywhere] grid min-w-0 grid-cols-[repeat(2,_minmax(140px,_1fr))] justify-self-end gap-2.5 max-[1181px]:w-full max-[1181px]:justify-self-stretch",
  "case-scope-heading":
    "grid gap-[3px] [&_span]:text-muted-foreground [&_span]:text-xs [&_summary]:cursor-pointer [&_summary]:text-muted-foreground [&_summary]:text-sm",
  "case-scope-toolbar":
    "grid grid-cols-[minmax(0,_1fr)_minmax(0,_2fr)] items-center gap-3 py-4 px-4.5 py-2 max-[1181px]:grid-cols-[1fr]",
  "failure-analysis-batch-actions":
    "flex flex-wrap items-center justify-end gap-2 [&_.ui-button]:[text-decoration:none]",
  "failure-analysis-batch-card":
    "[&_.failure-metric_dd]:text-destructive [&_.claimed-metric_dd]:text-info [&_.completed-metric_dd]:text-success grid min-w-0 gap-[9px] py-[15px] px-[17px] transition-colors duration-150 motion-reduce:transition-none [&:hover]:[border-color:color-mix(in_srgb,_var(--info)_24%,_var(--border))] [&:hover]:shadow-xs [&_.ui-card-content_>_p]:flex [&_.ui-card-content_>_p]:items-center [&_.ui-card-content_>_p]:gap-1.5 [&_.ui-card-content_>_p]:text-muted-foreground [&_.ui-card-content_>_p]:text-xs [&_dl]:grid [&_dl]:items-center [&_dl]:m-0 [&_dl]:grid-cols-2 [&_dl]:gap-[7px] [&_h2]:m-0 [&_h2]:overflow-hidden [&_h2]:text-lg [&_h2]:text-ellipsis [&_h2]:whitespace-nowrap [&_p]:m-0 [&_dl_>_div]:grid [&_dl_>_div]:gap-[3px] [&_dl_>_div]:py-[7px] [&_dl_>_div]:px-[9px] [&_dl_>_div]:rounded-lg [&_dl_>_div]:bg-muted [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:m-0 [&_dd]:font-semibold",
  "failure-analysis-batch-grid": "grid grid-cols-2 gap-3 max-[1025px]:grid-cols-[1fr]",
  "failure-analysis-batch-heading": "flex items-center justify-between gap-2",
  "failure-analysis-batch-progress":
    "grid gap-[7px] [&_>_span]:flex [&_>_span]:items-center [&_>_span]:justify-between [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_strong]:text-muted-foreground",
  "failure-analysis-empty":
    "grid min-h-[190px] place-items-center [align-content:center] gap-[9px] p-7 border border-dashed border-border rounded-lg bg-muted text-muted-foreground text-center [&_strong]:text-foreground",
  "failure-analysis-page": "gap-[clamp(14px,_1.5vw,_20px)]",
  "failure-analysis-pagination":
    "flex items-center justify-between gap-3 [&_>_span]:text-muted-foreground [&_>_span]:text-xs",
  "hero-icon":
    "inline-flex items-center gap-2 border border-solid border-border rounded-lg p-0 bg-card text-muted-foreground text-xs font-semibold shadow-xs w-12 h-12 justify-center [&.violet]:bg-muted [&.violet]:text-info",
} as const;
