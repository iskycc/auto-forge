import { buttonVariants } from "./ui/button-variants";

const container = "mx-auto w-[calc(100%-6rem)] max-w-[1400px] max-[1180px]:w-[calc(100%-3rem)]";
const caption = "text-xs leading-5 text-muted-foreground";
const sectionHeading =
  "flex items-end justify-between gap-5 [&_small]:text-xs [&_small]:text-muted-foreground [&_h2]:mt-2 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:text-sm [&_p]:text-muted-foreground";

/** Public landing content uses the same components and tokens as the console. */
const styles = {
  page: "min-h-screen bg-card text-foreground",
  header: `${container} flex min-h-20 items-center justify-between gap-6 border-b border-border`,
  hero: `${container} grid grid-cols-2 items-center gap-12 py-12 max-[1180px]:gap-6 [&_h1]:m-0 [&_h1]:text-4xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:leading-snug [&_h1>span]:block [&_h1>span]:whitespace-nowrap [&_em]:not-italic [&_em]:text-foreground`,
  metrics: `${container} grid grid-cols-4 rounded-xl border border-border bg-muted/40 py-6`,
  capabilities: `${container} py-12`,
  deployment: `${container} flex items-start justify-between gap-8 rounded-xl border border-border bg-muted/30 p-6`,
  footer: `${container} flex items-center justify-between gap-4 py-8 text-xs text-muted-foreground [&_a]:underline-offset-4 [&_a:hover]:underline`,
  brand:
    "flex items-center gap-3 [&>span:last-child]:grid [&>span:last-child]:gap-1 [&_strong]:text-xl [&_strong]:font-semibold [&_small]:text-xs [&_small]:text-muted-foreground",
  brandMark: "flex size-10 items-center justify-center rounded-lg bg-brand text-primary-foreground",
  navigation:
    "ml-auto flex items-center gap-6 text-sm text-muted-foreground [&_a]:py-3 [&_a:hover]:text-foreground",
  headerEntry: buttonVariants({ variant: "outline" }),
  primaryEntry: buttonVariants({ variant: "default", size: "lg" }),
  secondaryEntry: buttonVariants({ variant: "outline", size: "lg" }),
  heroCopy:
    "grid min-w-0 gap-5 [&>p]:m-0 [&>p]:text-base [&>p]:leading-7 [&>p]:text-muted-foreground",
  kicker: "flex items-center gap-2 text-sm font-medium text-muted-foreground",
  heroActions: "flex items-center gap-3",
  entryHint: caption,
  trustPoints:
    "flex flex-wrap gap-x-4 gap-y-2 p-0 text-xs text-muted-foreground [&_li]:flex [&_li]:items-center [&_li]:gap-1.5 [&_svg]:text-success",
  preview: "min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm",
  previewHeader:
    "flex min-h-14 items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 text-sm [&>div]:flex [&>div]:items-center [&>div]:gap-2 [&_small]:text-xs [&_small]:text-muted-foreground",
  previewFooter:
    "flex justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground",
  previewMark: "text-muted-foreground",
  refresh: `${buttonVariants({ variant: "ghost", size: "icon" })} size-8`,
  previewContent: "p-5",
  snapshotStatus:
    "mb-4 flex items-center gap-2 text-xs text-success data-[tone=warning]:text-warning data-[tone=neutral]:text-muted-foreground [&_i]:size-1.5 [&_i]:rounded-full [&_i]:bg-current",
  outcomeLegend:
    "m-0 grid min-w-0 gap-3 [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-3 [&_dt]:flex [&_dt]:items-center [&_dt]:gap-2 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-semibold [&_dd]:tabular-nums [&_i]:size-1.5 [&_i]:rounded-full [&_i]:bg-current [&_i[data-tone=success]]:text-success [&_i[data-tone=danger]]:text-destructive [&_i[data-tone=neutral]]:text-muted-foreground",
  previewKpis:
    "mb-5 grid grid-cols-3 divide-x divide-border [&>div]:grid [&>div]:min-w-0 [&>div]:gap-2 [&>div]:px-3 [&>div:first-child]:pl-0 [&>div:last-child]:pr-0 [&_span]:flex [&_span]:items-center [&_span]:gap-1 [&_span]:text-xs [&_span]:text-muted-foreground [&_strong]:text-2xl [&_strong]:font-semibold [&_strong]:tabular-nums [&_em]:text-sm [&_em]:font-normal [&_em]:not-italic [&_small]:text-xs [&_small]:text-muted-foreground",
  outcomes:
    "rounded-lg border border-border bg-muted/30 p-3 [&>header]:flex [&>header]:items-center [&>header]:justify-between [&>header]:gap-2 [&_h2]:text-sm [&_h2]:font-semibold [&>header>span]:text-xs [&>header>span]:text-muted-foreground",
  outcomeBody: "my-4 grid grid-cols-[112px_minmax(0,1fr)] items-center gap-6 max-[1180px]:gap-4",
  outcomeRing:
    "grid size-28 -rotate-90 place-items-center rounded-full [background:conic-gradient(var(--success)_0_var(--succeeded-share),var(--destructive)_var(--succeeded-share)_var(--completed-share),var(--border)_var(--completed-share)_100%)] [&>div]:flex [&>div]:size-[calc(100%-20px)] [&>div]:rotate-90 [&>div]:flex-col [&>div]:items-center [&>div]:justify-center [&>div]:gap-1 [&>div]:rounded-full [&>div]:bg-card [&_strong]:text-2xl [&_strong]:font-semibold [&_strong]:tabular-nums [&_span]:text-xs [&_span]:text-muted-foreground",
  outcomeNote: `${caption} border-t border-border pt-3`,
  metric:
    "min-w-0 border-r border-border px-6 last:border-0 [&>div]:flex [&>div]:items-center [&>div]:gap-2 [&_h2]:text-sm [&_h2]:font-medium [&_h2]:text-muted-foreground [&>strong]:my-2 [&>strong]:block [&>strong]:text-2xl [&>strong]:font-semibold [&>strong]:tabular-nums [&>small]:text-xs [&>small]:text-muted-foreground",
  metricIcon: "text-muted-foreground",
  sectionHeading: `${sectionHeading} mb-6`,
  deploymentIntro: `${sectionHeading} block [&_p]:mt-3 [&_p]:leading-6`,
  capabilityGrid: "grid grid-cols-3 gap-4",
  capability:
    "flex min-w-0 flex-col rounded-xl border border-border bg-card p-6 [&_h3]:mb-3 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:mb-5 [&_p]:flex-1 [&_p]:text-sm [&_p]:leading-7 [&_p]:text-muted-foreground [&_ul]:m-0 [&_ul]:flex [&_ul]:flex-wrap [&_ul]:gap-3 [&_ul]:border-t [&_ul]:border-border [&_ul]:pt-4 [&_li]:flex [&_li]:items-center [&_li]:gap-1 [&_li]:text-xs [&_li]:text-muted-foreground",
  capabilityTop:
    "flex items-center justify-between [&>span]:flex [&>span]:size-10 [&>span]:items-center [&>span]:justify-center [&>span]:rounded-lg [&>span]:border [&>span]:border-border [&>span]:bg-muted/40 [&>span]:text-muted-foreground [&>small]:font-mono [&>small]:text-xs [&>small]:text-muted-foreground",
  executionFlow:
    "mt-6 [&_ol]:grid [&_ol]:grid-cols-4 [&_ol]:gap-4 [&_ol]:rounded-lg [&_ol]:bg-muted/40 [&_ol]:p-5 [&_li]:flex [&_li]:min-w-0 [&_li]:items-center [&_li]:gap-3 [&_li>div]:flex [&_li>div]:flex-col [&_li>div]:gap-1 [&_strong]:text-sm [&_strong]:font-semibold [&_small]:text-xs [&_small]:text-muted-foreground",
  stageIcon: "shrink-0 text-muted-foreground",
  stageArrow: "ml-auto shrink-0 text-muted-foreground",
  deploymentIcon: "mt-1 text-muted-foreground",
} as const;
export default styles;
