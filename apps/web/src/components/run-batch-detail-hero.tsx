import { Notice } from "@/components/ui/notice";
import { Tooltip } from "antd";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { ArrowLeft, Clock3, Link2 } from "lucide-react";
import Link from "next/link";
import { ColorModeToggle } from "./color-mode-toggle";

export function RunBatchDetailHero({
  batchId,
  sequenceNumber,
  suiteName,
  suiteVersion,
  projectVersionName,
  requestedByUsername,
  shared = false,
}: {
  batchId: string;
  sequenceNumber: number;
  suiteName: string;
  suiteVersion: number;
  projectVersionName?: string;
  requestedByUsername?: string;
  shared?: boolean;
}) {
  return (
    <>
      {!shared ? (
        <Link
          className={cn("back-link", runBatchDetailHeroStyles["back-link"])}
          href="/execution-records"
        >
          <ArrowLeft size={16} /> 返回执行记录
        </Link>
      ) : null}
      {shared ? (
        <Notice
          tone="info"
          className={cn(
            "shared-run-detail-notice",
            runBatchDetailHeroStyles["shared-run-detail-notice"],
          )}
          role="status"
        >
          <Link2 size={16} aria-hidden="true" />
          永久匿名只读执行详情
        </Notice>
      ) : null}
      <section
        className={cn(
          "page-hero execution-detail-hero",
          uiPatterns["page-hero"],
          runBatchDetailHeroStyles["execution-detail-hero"],
        )}
      >
        <div className="min-w-0 flex-1">
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Execution Batch</span>
          <h1>{suiteName}</h1>
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
        {shared ? (
          <ColorModeToggle />
        ) : (
          <span className={cn("hero-icon violet", runBatchDetailHeroStyles["hero-icon"])}>
            <Clock3 size={24} />
          </span>
        )}
      </section>
    </>
  );
}

const runBatchDetailHeroStyles = {
  "back-link":
    "text-muted-foreground font-semibold inline-flex items-center gap-1.5 mb-[5px] text-sm w-fit [&:hover]:[text-decoration:underline]",
  "execution-detail-hero": "[&_h1]:[overflow-wrap:anywhere] [&_p]:[overflow-wrap:anywhere]",
  "hero-icon":
    "inline-flex items-center gap-2 border border-solid border-border rounded-lg p-0 bg-card text-muted-foreground text-xs font-semibold shadow-xs w-12 h-12 justify-center [&.violet]:bg-muted [&.violet]:text-info",
  "shared-run-detail-notice":
    "inline-flex w-fit items-center gap-[7px] border border-solid border-transparent rounded-full py-[7px] px-[11px] bg-info/10 text-info text-xs font-semibold",
} as const;
