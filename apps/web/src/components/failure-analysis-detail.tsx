"use client";
import { LinkButton } from "@/components/ui/link-button";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type {
  FailureAnalysisBatch,
  FailureAnalysisCandidatePage,
  FailureAnalysisClaimView,
} from "@autoforge/contracts";
import { ArrowLeft, SearchCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

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
  currentUserId,
  projectId,
  projectVersionId,
  initialCandidatePage,
  initialClaimPage,
  initialFilters,
  initialMyClaimCount,
  initialView,
}: {
  batch: FailureAnalysisBatch;
  canManage: boolean;
  canAssign: boolean;
  canReadStatistics: boolean;
  currentUserId: string;
  projectId: string;
  projectVersionId: string;
  initialCandidatePage: FailureAnalysisCandidatePage | null | undefined;
  initialClaimPage: { items: FailureAnalysisClaimView[]; nextCursor?: string } | undefined;
  initialFilters: FailureAnalysisWorkspaceFilters;
  initialMyClaimCount: number;
  initialView: "claim" | "workbench";
}) {
  const [claimedRuns, setClaimedRuns] = useState(batch.claimedRuns);
  const [completedRuns, setCompletedRuns] = useState(batch.completedRuns);

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
            href="/case-analysis"
          >
            <ArrowLeft size={14} /> 返回分析任务
          </Link>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>
            Failure Analysis · #{batch.sequenceNumber}
          </span>
          <h1>{batch.suiteName}</h1>
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
          <span className={cn("hero-icon violet", failureAnalysisDetailStyles["hero-icon"])}>
            <SearchCheck size={24} />
          </span>
        </div>
      </section>
      <FailureAnalysisWorkspace
        canManage={canManage}
        canAssign={canAssign}
        currentUserId={currentUserId}
        initialCandidatePage={initialCandidatePage}
        initialBatchId={batch.id}
        initialClaimPage={initialClaimPage}
        initialFilters={initialFilters}
        initialMyClaimCount={initialMyClaimCount}
        initialView={initialView}
        onClaimCountDelta={(delta) => setClaimedRuns((current) => Math.max(0, current + delta))}
        onCompletedCountDelta={(delta) =>
          setCompletedRuns((current) => Math.max(0, current + delta))
        }
        projectId={projectId}
        projectVersionId={projectVersionId}
      />
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
