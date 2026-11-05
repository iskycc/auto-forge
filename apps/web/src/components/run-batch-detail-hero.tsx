import { Tooltip } from "antd";
import { cn } from "@/lib/utils";
import { ArrowLeft, Link2 } from "lucide-react";
import Link from "next/link";
import { ColorModeToggle } from "./color-mode-toggle";
import type { ReactNode } from "react";

export function RunBatchDetailHero({
  batchId,
  sequenceNumber,
  suiteName,
  suiteVersion,
  projectVersionName,
  requestedByUsername,
  shared = false,
  sharedActions,
}: {
  batchId: string;
  sequenceNumber: number;
  suiteName: string;
  suiteVersion: number;
  projectVersionName?: string;
  requestedByUsername?: string;
  shared?: boolean;
  sharedActions?: ReactNode;
}) {
  return (
    <header className="execution-detail-hero grid min-w-0 gap-3">
      <div className="flex min-w-0 items-center justify-between gap-4 text-sm">
        {!shared ? (
          <Link
            className={cn("back-link", runBatchDetailHeroStyles["back-link"])}
            href="/execution-records"
          >
            <ArrowLeft size={16} /> 返回执行记录
          </Link>
        ) : null}
        {shared ? (
          <span
            className="shared-run-detail-notice inline-flex items-center gap-2 text-muted-foreground"
            role="status"
          >
            <Link2 size={16} aria-hidden="true" />
            永久匿名只读执行详情
          </span>
        ) : null}
        {shared ? (
          <div className="flex shrink-0 items-center gap-2">
            {sharedActions}
            <ColorModeToggle />
          </div>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
          {suiteName}
        </h1>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <p className="!m-0" title={batchId}>
            批次 #{sequenceNumber} · 任务版本 v{suiteVersion} · 项目版本
            {projectVersionName ? `「${projectVersionName}」` : "未关联"}
          </p>
          {!shared ? (
            <div className="execution-batch-initiator flex min-w-0 max-w-full items-center gap-1">
              <span className="shrink-0">拉起人：</span>
              <Tooltip title={requestedByUsername} trigger={["hover", "focus"]}>
                <span
                  className="execution-batch-initiator-username min-w-0 max-w-64 truncate text-foreground"
                  title={requestedByUsername}
                  tabIndex={requestedByUsername ? 0 : undefined}
                >
                  {requestedByUsername ?? "未记录"}
                </span>
              </Tooltip>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

const runBatchDetailHeroStyles = {
  "back-link":
    "text-muted-foreground font-medium inline-flex items-center gap-1.5 text-sm w-fit [&:hover]:[text-decoration:underline]",
} as const;
