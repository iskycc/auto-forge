"use client";
import { Alert, Tag } from "antd";
import { LinkButton } from "@/components/ui/link-button";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type {
  FailureAnalysisBatch,
  FailureAnalysisCandidatePage,
  FailureAnalysisClaimView,
  FailureAnalysisSheetPage,
} from "@autoforge/contracts";
import { ArrowLeft, SearchCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs } from "./ui/tabs";
import { FailureAnalysisSheet } from "./failure-analysis-sheet";
import { FailureAnalysisPublicationButton } from "./failure-analysis-publication-button";
import { useConfirm } from "./ui-feedback";
import { analysisWorkspaceLayout } from "@/lib/failure-analysis-layout";

import { FailureAnalysisExportButton } from "@/components/failure-analysis-export-button";
import {
  FailureAnalysisWorkspace,
  type FailureAnalysisWorkspaceFilters,
} from "@/components/failure-analysis-workspace";

export function FailureAnalysisDetail({
  batch,
  canManage,
  canAssign,
  canReadStatistics,
  canPublish,
  currentUserId,
  projectId,
  projectVersionId,
  initialCandidatePage,
  initialClaimPage,
  initialFilters,
  initialMyClaimCount,
  initialView,
  initialSheetPage,
}: {
  batch: FailureAnalysisBatch;
  canManage: boolean;
  canAssign: boolean;
  canReadStatistics: boolean;
  canPublish: boolean;
  currentUserId: string;
  projectId: string;
  projectVersionId: string;
  initialCandidatePage: FailureAnalysisCandidatePage | null | undefined;
  initialClaimPage: { items: FailureAnalysisClaimView[]; nextCursor?: string } | undefined;
  initialFilters: FailureAnalysisWorkspaceFilters;
  initialMyClaimCount: number;
  initialView: "claim" | "workbench";
  initialSheetPage?: FailureAnalysisSheetPage | undefined;
}) {
  const [claimedRuns, setClaimedRuns] = useState(batch.claimedRuns);
  const [completedRuns, setCompletedRuns] = useState(batch.completedRuns);
  const parameters = useSearchParams();
  const [layout, setLayout] = useState<"sheet" | "classic">(() =>
    analysisWorkspaceLayout(parameters),
  );
  const confirm = useConfirm();
  const [sheetDirty, setSheetDirty] = useState(false);
  const [layoutChanges, setLayoutChanges] = useState(0);
  const [myClaims, setMyClaims] = useState(initialMyClaimCount);
  async function changeLayout(next: "sheet" | "classic") {
    if (next === layout) return;
    if (
      sheetDirty &&
      !(await confirm({
        title: "切换工作台并放弃草稿？",
        description: "表格中还有未提交的分析草稿，切换后这些草稿将丢失。已提交的结论不受影响。",
        confirmLabel: "放弃草稿并切换",
        tone: "danger",
      }))
    )
      return;
    setSheetDirty(false);
    setLayout(next);
    setLayoutChanges((current) => current + 1);
    const url = new URL(window.location.href);
    url.searchParams.set("layout", next);
    window.history.replaceState(null, "", url);
  }

  return (
    <div
      className={cn(
        "page-stack failure-analysis-page",
        uiPatterns["page-stack"],
        failureAnalysisDetailStyles["failure-analysis-page"],
      )}
    >
      <section className={cn("page-hero failure-analysis-detail-hero", uiPatterns["page-hero"])}>
        <div
          className={cn(
            "failure-analysis-detail-heading",
            failureAnalysisDetailStyles["failure-analysis-detail-heading"],
          )}
        >
          <Link
            className={cn("text-link", failureAnalysisDetailStyles["text-link"])}
            href={batch.archivedAt ? "/case-analysis?view=archived" : "/case-analysis"}
          >
            <ArrowLeft size={14} /> {batch.archivedAt ? "返回已归档任务" : "返回分析任务"}
          </Link>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>
            Failure Analysis · #{batch.sequenceNumber}
          </span>
          <h1>{batch.suiteName}</h1>
          {batch.archivedAt ? <Tag className="m-0 w-fit">已归档 · 只读</Tag> : null}
          <div
            className={cn(
              "failure-analysis-detail-metrics",
              failureAnalysisDetailStyles["failure-analysis-detail-metrics"],
            )}
            aria-label="任务分析概览"
          >
            <span>
              最终轮次 <strong>第 {batch.currentRound} 轮</strong>
            </span>
            <span className={"failure-metric"}>
              最终失败 <strong>{batch.failedRuns}</strong>
            </span>
            <span className={"claimed-metric"}>
              已认领 <strong>{claimedRuns}</strong>
            </span>
            <span className={"completed-metric"}>
              已完成 <strong>{completedRuns}</strong>
            </span>
          </div>
        </div>
        <div
          className={cn(
            "failure-analysis-detail-actions",
            failureAnalysisDetailStyles["failure-analysis-detail-actions"],
          )}
        >
          <LinkButton
            className={"ui-button ui-button-secondary"}
            prefetch={false}
            href={`/run-batches/${encodeURIComponent(batch.id)}`}
          >
            执行详情
          </LinkButton>
          {canReadStatistics ? (
            <LinkButton
              className={"ui-button ui-button-secondary"}
              prefetch={false}
              href={`/case-analysis/${encodeURIComponent(batch.id)}/statistics`}
            >
              分析统计
            </LinkButton>
          ) : null}
          <FailureAnalysisExportButton batchId={batch.id} />
          {canPublish ? <FailureAnalysisPublicationButton batchId={batch.id} /> : null}
          <span className={cn("hero-icon violet", failureAnalysisDetailStyles["hero-icon"])}>
            <SearchCheck size={24} />
          </span>
        </div>
      </section>
      {batch.archivedAt ? (
        <Alert
          showIcon
          type="info"
          title="该分析任务已归档"
          description="分析结论和证明材料已保留，可查看历史、分析统计及导出；不再接受认领、分配或修改。"
        />
      ) : null}
      <Tabs
        label="分析工作区布局"
        value={layout}
        items={[
          { key: "sheet", label: "表格分析" },
          { key: "classic", label: "详细工作台" },
        ]}
        onChange={(next) => void changeLayout(next)}
      />
      {layout === "sheet" ? (
        <div className="min-w-0">
          <FailureAnalysisSheet
            endpoint={`/api/v1/failure-analysis/batches/${encodeURIComponent(batch.id)}/sheet`}
            currentUserId={currentUserId}
            canManage={canManage}
            stickyHeaderOffset={64}
            initialPage={layoutChanges === 0 ? initialSheetPage : undefined}
            onDirtyChange={setSheetDirty}
            onClaimed={(count) => {
              setClaimedRuns((current) => Math.max(0, current + count));
              setMyClaims((current) => Math.max(0, current + count));
            }}
            onCompleted={(count) => setCompletedRuns((current) => current + count)}
          />
        </div>
      ) : null}
      {layout === "classic" ? (
        <div className="min-w-0">
          <FailureAnalysisWorkspace
            canManage={canManage}
            canAssign={canAssign}
            currentUserId={currentUserId}
            initialCandidatePage={layoutChanges === 0 ? initialCandidatePage : undefined}
            initialBatchId={batch.id}
            initialClaimPage={layoutChanges === 0 ? initialClaimPage : undefined}
            initialFilters={initialFilters}
            initialMyClaimCount={myClaims}
            initialView={
              parameters.get("view") === "claim"
                ? "claim"
                : parameters.get("view") === "workbench"
                  ? "workbench"
                  : myClaims > 0
                    ? "workbench"
                    : initialView
            }
            onMyClaimCountChange={setMyClaims}
            onClaimCountDelta={(delta) => {
              setClaimedRuns((current) => Math.max(0, current + delta));
            }}
            onCompletedCountDelta={(delta) =>
              setCompletedRuns((current) => Math.max(0, current + delta))
            }
            projectId={projectId}
            projectVersionId={projectVersionId}
          />
        </div>
      ) : null}
    </div>
  );
}

const failureAnalysisDetailStyles = {
  "failure-analysis-detail-actions": "flex flex-wrap items-center justify-end gap-2",
  "failure-analysis-detail-heading":
    "grid min-w-0 gap-[5px] [&_>_.text-link]:w-fit [&_>_.text-link]:mb-0.5 [&_>_h1]:[overflow-wrap:anywhere]",
  "failure-analysis-detail-metrics":
    "flex flex-wrap gap-2 mt-[5px] [&_>_span]:inline-flex [&_>_span]:items-center [&_>_span]:gap-1.5 [&_>_span]:border [&_>_span]:border-solid [&_>_span]:border-border [&_>_span]:rounded-full [&_>_span]:py-1.5 [&_>_span]:px-2.5 [&_>_span]:[background:color-mix(in_srgb,_var(--card)_86%,_transparent)] [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_strong]:text-foreground [&_.failure-metric_strong]:text-destructive [&_.claimed-metric_strong]:text-info [&_.completed-metric_strong]:text-success",
  "failure-analysis-page": "gap-[clamp(14px,_1.5vw,_20px)]",
  "hero-icon":
    "inline-flex items-center gap-2 border border-solid border-border rounded-lg p-0 bg-card text-muted-foreground text-xs font-semibold shadow-xs w-12 h-12 justify-center [&.violet]:bg-muted [&.violet]:text-info",
  "text-link":
    "inline-flex items-center gap-[5px] text-info text-xs font-semibold [&:hover]:[text-decoration:underline]",
} as const;
