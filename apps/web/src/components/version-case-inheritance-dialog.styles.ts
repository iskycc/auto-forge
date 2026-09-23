/** Component compositions using the shared Ant Design theme. */
const styles = {
  dialog: "version-case-inheritance-dialog-dialog max-w-[680px]",
  content: "version-case-inheritance-dialog-content grid gap-4 min-w-0",
  target:
    "version-case-inheritance-dialog-target grid gap-2 p-4 rounded-lg bg-muted [overflow-wrap:anywhere] [&_>_span]:text-muted-foreground",
  progress:
    "version-case-inheritance-dialog-progress grid gap-2 p-4 rounded-lg bg-muted [overflow-wrap:anywhere]",
  rules:
    "version-case-inheritance-dialog-rules text-muted-foreground m-0 pl-5 grid gap-2 [overflow-wrap:anywhere]",
  fields:
    "version-case-inheritance-dialog-fields grid grid-cols-2 gap-4 [&_label]:grid [&_label]:gap-2 [&_label]:min-w-0 [&_select]:min-w-0 [&_select]:max-w-full",
} as const;
export default styles;
