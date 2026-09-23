import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { ArrowLeft, Clock3, Link2 } from "lucide-react";
import Link from "next/link";

export function RunBatchDetailHero({
  batchId,
  sequenceNumber,
  suiteName,
  suiteVersion,
  projectVersionName,
  shared = false,
}: {
  batchId: string;
  sequenceNumber: number;
  suiteName: string;
  suiteVersion: number;
  projectVersionName?: string;
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
        <div
          className={cn(
            "shared-run-detail-notice",
            runBatchDetailHeroStyles["shared-run-detail-notice"],
          )}
          role="status"
        >
          <Link2 size={16} aria-hidden="true" />
          永久匿名只读执行详情
        </div>
      ) : null}
      <section
        className={cn(
          "page-hero execution-detail-hero",
          uiPatterns["page-hero"],
          runBatchDetailHeroStyles["execution-detail-hero"],
        )}
      >
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Execution Batch</span>
          <h1>{suiteName}</h1>
          <p title={batchId}>
            批次 #{sequenceNumber} · 任务版本 v{suiteVersion} · 项目版本
            {projectVersionName ? `「${projectVersionName}」` : "未关联"}
          </p>
        </div>
        <span className={cn("hero-icon violet", runBatchDetailHeroStyles["hero-icon"])}>
          <Clock3 size={24} />
        </span>
      </section>
    </>
  );
}

const runBatchDetailHeroStyles = {
  "back-link":
    "text-muted-foreground font-semibold inline-flex items-center gap-1.5 mb-[5px] text-sm w-fit [&:hover]:[text-decoration:underline]",
  "execution-detail-hero": "[&_p]:[overflow-wrap:anywhere]",
  "hero-icon":
    "inline-flex items-center gap-2 border border-solid border-border rounded-lg p-0 bg-card text-muted-foreground text-xs font-semibold shadow-xs w-12 h-12 justify-center [&.violet]:bg-muted [&.violet]:text-info",
  "shared-run-detail-notice":
    "inline-flex w-fit items-center gap-[7px] border border-solid border-transparent rounded-full py-[7px] px-[11px] bg-info/10 text-info text-xs font-semibold",
} as const;
