import type { RunBatch } from "@autoforge/domain";

export function ExecutionActors({
  publicExecution,
  terminatedBy,
}: {
  publicExecution?: RunBatch["publicExecution"];
  terminatedBy?: RunBatch["terminatedBy"];
}) {
  if (!publicExecution && !terminatedBy) return null;
  return (
    <div
      aria-label="执行操作人"
      className="flex min-w-0 flex-wrap gap-x-6 gap-y-2 rounded-lg border border-border bg-muted px-5 py-3 text-sm"
    >
      {publicExecution ? (
        <>
          <span className="[overflow-wrap:anywhere]">
            <span className="text-muted-foreground">链接分享人：</span>
            {publicExecution.publisher.username}
          </span>
          <span className="[overflow-wrap:anywhere]">
            <span className="text-muted-foreground">执行拉起人：</span>
            {publicExecution.initiator.username}
          </span>
        </>
      ) : null}
      {terminatedBy ? (
        <span className="[overflow-wrap:anywhere]">
          <span className="text-muted-foreground">任务终止人：</span>
          {terminatedBy.username}
        </span>
      ) : null}
    </div>
  );
}
