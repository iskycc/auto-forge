"use client";

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
    <div className="page-stack failure-analysis-page">
      <section className="page-hero failure-analysis-detail-hero">
        <div className="failure-analysis-detail-heading">
          <Link className="text-link" href="/case-analysis">
            <ArrowLeft size={14} /> 返回分析任务
          </Link>
          <span className="eyebrow">Failure Analysis · #{batch.sequenceNumber}</span>
          <h1>{batch.suiteName}</h1>
          <div className="failure-analysis-detail-metrics" aria-label="任务分析概览">
            <span>
              最终轮次 <strong>第 {batch.currentRound} 轮</strong>
            </span>
            <span className="failure-metric">
              最终失败 <strong>{batch.failedRuns}</strong>
            </span>
            <span className="claimed-metric">
              已认领 <strong>{claimedRuns}</strong>
            </span>
            <span className="completed-metric">
              已完成 <strong>{completedRuns}</strong>
            </span>
          </div>
        </div>
        <div className="failure-analysis-detail-actions">
          <Link
            className="ui-button ui-button-secondary"
            prefetch={false}
            href={`/run-batches/${encodeURIComponent(batch.id)}`}
          >
            执行详情
          </Link>
          {canReadStatistics ? (
            <Link
              className="ui-button ui-button-secondary"
              prefetch={false}
              href={`/case-analysis/${encodeURIComponent(batch.id)}/statistics`}
            >
              分析统计
            </Link>
          ) : null}
          <FailureAnalysisExportButton batchId={batch.id} />
          <span className="hero-icon violet">
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
