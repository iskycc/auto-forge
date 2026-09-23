import { buttonVariants } from "./button";
import { badgeVariants } from "./badge";

/** Shared Ant Design token-based compositions for business layouts. */
const surface = "min-w-0 rounded-xl border border-border bg-card text-card-foreground shadow-xs";
const caption = "text-xs leading-5 text-muted-foreground";
const field = "grid min-w-0 gap-2 text-sm font-medium";
const toolbar = "flex min-w-0 flex-wrap items-center gap-3";

export const uiPatterns = {
  "batch-status": `${badgeVariants({ variant: "info" })} [&.batch-status-queued]:bg-warning/10 [&.batch-status-queued]:text-warning [&.batch-status-running]:bg-info/10 [&.batch-status-running]:text-info [&.batch-status-blocked]:bg-warning/10 [&.batch-status-blocked]:text-warning [&.batch-status-scheduled]:bg-success/10 [&.batch-status-scheduled]:text-success [&.batch-status-succeeded]:bg-success/10 [&.batch-status-succeeded]:text-success [&.batch-status-failed]:bg-destructive/10 [&.batch-status-failed]:text-destructive [&.batch-status-neutral]:bg-muted [&.batch-status-neutral]:text-muted-foreground`,

  "execution-log":
    "min-h-[280px] max-h-[560px] overflow-auto mb-2.5 rounded-md border border-border bg-muted p-4 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap [overflow-wrap:anywhere] [&_.ansi-bold]:font-semibold [&_.ansi-black]:text-foreground [&_.ansi-red]:text-destructive [&_.ansi-green]:text-success [&_.ansi-yellow]:text-warning [&_.ansi-blue]:text-info [&_.ansi-magenta]:text-[var(--ansi-magenta)] [&_.ansi-cyan]:text-[var(--ansi-cyan)] [&_.ansi-white]:text-foreground [&_.ansi-bright-black]:text-muted-foreground [&_.ansi-bright-red]:text-destructive [&_.ansi-bright-green]:text-success [&_.ansi-bright-yellow]:text-warning [&_.ansi-bright-blue]:text-info [&_.ansi-bright-magenta]:text-[var(--ansi-magenta)] [&_.ansi-bright-cyan]:text-[var(--ansi-cyan)] [&_.ansi-bright-white]:text-foreground [&_.log-level-trace]:text-muted-foreground [&_.log-level-debug]:text-muted-foreground [&_.log-level-info]:text-info [&_.log-level-warn]:font-semibold [&_.log-level-warn]:text-warning [&_.log-level-error]:font-semibold [&_.log-level-error]:text-destructive [&_.log-level-fatal]:font-semibold [&_.log-level-fatal]:text-destructive",
  "execution-log-dark":
    "border-border bg-[var(--terminal-background)] text-foreground [--foreground:var(--terminal-foreground)] [--muted-foreground:var(--terminal-white)] [--destructive:var(--terminal-red)] [--success:var(--terminal-green)] [--warning:var(--terminal-yellow)] [--info:var(--terminal-blue)] [--ansi-magenta:var(--terminal-magenta)] [--ansi-cyan:var(--terminal-cyan)]",
  button: buttonVariants({ variant: "outline" }),
  "button-primary":
    "border-transparent bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50",
  "primary-button":
    "border-transparent bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50",
  "button-secondary": "border-input bg-card text-foreground hover:bg-accent disabled:opacity-50",
  "secondary-button": "border-input bg-card text-foreground hover:bg-accent disabled:opacity-50",
  "button-large": "h-10 px-4",
  "compact-button": "h-8 px-2.5 text-xs",
  "button-danger-quiet":
    "border-destructive/20 bg-destructive/5 text-destructive hover:bg-destructive/10",
  "button-success": "border-success/20 bg-success/10 text-success hover:bg-success/15",
  "danger-text-button":
    "border-transparent bg-transparent text-destructive shadow-none hover:bg-destructive/10",
  "text-button":
    "min-h-8 border-transparent bg-transparent px-1 py-1 text-sm font-medium text-foreground shadow-none hover:underline",
  "icon-button":
    "inline-flex size-9 shrink-0 items-center justify-center rounded-md border-transparent bg-transparent p-0 text-muted-foreground shadow-none hover:bg-accent hover:text-foreground",
  "small-icon-button": "size-8 p-0",
  "page-stack": "mx-auto flex w-full max-w-[2160px] min-w-0 flex-col gap-5",
  "settings-stack": "grid min-w-0 gap-5",
  "narrow-page": "max-w-6xl",
  "page-hero":
    "flex min-w-0 flex-wrap items-start justify-between gap-4 py-1 [&_h1]:m-0 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_p]:mt-2 [&_p]:text-sm [&_p]:leading-6 [&_p]:text-muted-foreground",
  "page-header":
    "flex min-w-0 flex-wrap items-start justify-between gap-4 [&_h1]:m-0 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_p]:mt-2 [&_p]:text-sm [&_p]:leading-6 [&_p]:text-muted-foreground",
  "settings-page-header": "flex-col items-start gap-4",
  card: surface,
  "content-card": `${surface} p-5`,
  "settings-section": "min-w-0 p-5",
  "card-heading":
    "mb-4 flex min-w-0 items-start justify-between gap-3 [&_h2]:m-0 [&_h2]:text-base [&_h2]:font-semibold [&_p]:mt-1 [&_p]:text-sm [&_p]:text-muted-foreground",
  "section-heading":
    "mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3 [&_h2]:m-0 [&_h2]:text-base [&_h2]:font-semibold [&_p]:mt-1 [&_p]:text-sm [&_p]:text-muted-foreground",
  "section-title-row":
    "flex min-h-18 min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 [&_h2]:text-base [&_h2]:font-semibold",
  eyebrow: "mb-1 block text-xs font-medium tracking-wide text-muted-foreground",
  muted: "text-muted-foreground",
  "settings-note": `${caption} m-0 [overflow-wrap:anywhere]`,
  "field-hint": `${caption} font-normal`,
  "table-secondary": `${caption} mt-1 block [overflow-wrap:anywhere]`,
  "button-row": "flex flex-wrap items-center gap-2",
  "field-stack": field,
  "settings-grid-form":
    "grid min-w-0 grid-cols-2 gap-4 [&_label]:min-w-0 [&_label]:text-sm [&_label]:font-medium [&_label:not(.checkbox-field)]:grid [&_label:not(.checkbox-field)]:content-start [&_label:not(.checkbox-field)]:gap-2",
  "settings-wide-field": "col-span-full min-w-0",
  "full-span": "col-span-full",
  "settings-subform": "grid min-w-0 gap-4 rounded-lg border border-border p-4",
  "checkbox-field": "flex min-w-0 items-center gap-2 text-sm",
  "checkbox-row": "flex min-w-0 items-center gap-2 text-sm",
  "table-scroll": "w-full min-w-0 overflow-x-auto",
  "data-table":
    "w-full border-collapse text-left text-sm [&_thead]:bg-muted/60 [&_th]:h-10 [&_th]:px-4 [&_th]:py-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:border-b [&_td]:border-border [&_td]:px-4 [&_td]:py-3 [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/40 [&_tbody_tr:last-child_td]:border-b-0 [&_time]:whitespace-nowrap [&_time]:text-xs [&_time]:text-muted-foreground",
  "management-toolbar": `${toolbar} my-3 items-end [&>label]:grid [&>label]:min-w-0 [&>label]:flex-1 [&>label]:gap-2 [&>.ui-input]:min-w-40 [&>.ui-input]:max-w-[420px] [&>.ui-input]:flex-1 [&>.ui-select]:min-w-40 [&>.ui-select]:max-w-[420px] [&>.ui-select]:flex-1`,
  "management-pagination":
    "mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm text-muted-foreground [&>div]:flex [&>div]:gap-2",
  "form-error":
    "rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm leading-6 text-destructive [overflow-wrap:anywhere]",
  "auth-error":
    "rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm leading-6 text-destructive [overflow-wrap:anywhere]",
  error: "text-sm leading-6 text-destructive [overflow-wrap:anywhere]",
  "inline-notice":
    "rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]",
  "warning-notice":
    "rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-sm leading-6 text-warning [overflow-wrap:anywhere]",
  "inline-empty": "m-0 px-4 py-6 text-center text-sm leading-6 text-muted-foreground",
  "table-empty": "px-4 py-10 text-center text-sm text-muted-foreground",
  "empty-state":
    "flex min-w-0 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center [&_h2]:m-0 [&_h2]:text-base [&_h2]:font-semibold [&_p]:m-0 [&_p]:max-w-xl [&_p]:text-sm [&_p]:leading-6 [&_p]:text-muted-foreground",
  "empty-icon":
    "inline-flex size-10 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground",
  "visually-hidden": "sr-only",
  spin: "animate-spin motion-reduce:animate-none",

  "permission-chip":
    "inline-flex max-w-full items-center rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-foreground [overflow-wrap:anywhere]",
  tag: "inline-flex max-w-full items-center rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground",
} as const;
