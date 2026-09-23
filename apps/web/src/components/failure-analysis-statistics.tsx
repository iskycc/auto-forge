"use client";
import { Notice } from "@/components/ui/notice";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type {
  FailureAnalysisAnalystStatistics,
  FailureAnalysisClaimPageView,
  FailureAnalysisClaimView,
  FailureAnalysisStatisticsPage,
} from "@autoforge/contracts";
import { BarChart3, ChevronRight, ClipboardCheck, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { Statistic } from "antd";

import { ActionDialog } from "@/components/action-dialog";
import { Button, ProgressBar } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

type ClaimPage = FailureAnalysisClaimPageView;

export function FailureAnalysisStatistics({
  initialPage,
  failedRuns,
  batchId,
  projectId,
  projectVersionId,
}: {
  initialPage: FailureAnalysisStatisticsPage;
  failedRuns: number;
  projectId: string;
  batchId: string;
  projectVersionId?: string;
}) {
  const [previousPage, setPreviousPage] = useState(initialPage);
  const [analysts, setAnalysts] = useState(initialPage.analysts);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedAnalyst, setSelectedAnalyst] = useState<FailureAnalysisAnalystStatistics>();
  const [claims, setClaims] = useState<FailureAnalysisClaimView[]>([]);
  const [claimCursor, setClaimCursor] = useState<string>();
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [error, setError] = useState("");
  if (previousPage !== initialPage) {
    setPreviousPage(initialPage);
    setAnalysts(initialPage.analysts);
    setNextCursor(initialPage.nextCursor);
  }
  const summary = initialPage.summary;
  const completionRate = percent(summary.completed, failedRuns);

  async function loadMoreAnalysts(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const page = await requestStatistics(nextCursor);
      setAnalysts((current) => [...current, ...page.analysts]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取分析统计失败。");
    } finally {
      setLoadingMore(false);
    }
  }

  async function openAnalyst(analyst: FailureAnalysisAnalystStatistics): Promise<void> {
    setSelectedAnalyst(analyst);
    setClaims([]);
    setClaimCursor(undefined);
    await loadClaims(analyst, undefined, false);
  }

  async function loadClaims(
    analyst: FailureAnalysisAnalystStatistics,
    cursor: string | undefined,
    append: boolean,
  ): Promise<void> {
    setClaimsLoading(true);
    setError("");
    try {
      const parameters = scopeParameters();
      parameters.set("limit", "30");
      if (cursor) parameters.set("cursor", cursor);
      const response = await fetch(
        `/api/v1/failure-analysis/statistics/${encodeURIComponent(analyst.claimantId)}/claims?${parameters}`,
        { cache: "no-store" },
      );
      const message = await readApiErrorMessage(response, "读取分析内容失败。");
      if (message) throw new Error(message);
      const page = (await response.json()) as ClaimPage;
      setClaims((current) => (append ? [...current, ...page.items] : page.items));
      setClaimCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取分析内容失败。");
    } finally {
      setClaimsLoading(false);
    }
  }

  async function requestStatistics(cursor: string): Promise<FailureAnalysisStatisticsPage> {
    const parameters = scopeParameters();
    parameters.set("limit", "50");
    parameters.set("cursor", cursor);
    const response = await fetch(`/api/v1/failure-analysis/statistics?${parameters}`, {
      cache: "no-store",
    });
    const message = await readApiErrorMessage(response, "读取分析统计失败。");
    if (message) throw new Error(message);
    return (await response.json()) as FailureAnalysisStatisticsPage;
  }

  function scopeParameters(): URLSearchParams {
    const parameters = new URLSearchParams({ projectId, batchId });
    if (projectVersionId) parameters.set("projectVersionId", projectVersionId);
    return parameters;
  }

  return (
    <>
      <section
        className={cn(
          "failure-analysis-stat-summary",
          failureAnalysisStatisticsStyles["failure-analysis-stat-summary"],
        )}
        aria-label="分析总览"
      >
        <StatisticMetric label="待分析用例总数" value={failedRuns} />
        <StatisticMetric label="尚未认领或分配" value={Math.max(0, failedRuns - summary.total)} />
        <StatisticMetric label="已认领或分配" value={summary.total} />
        <StatisticMetric label="已完成分析" value={summary.completed} />
        <StatisticMetric label="正在分析" value={summary.analyzing} />
        <StatisticMetric label="完成率" value={`${completionRate}%`} />
      </section>

      <Card
        as="section"
        className={cn(
          "content-card failure-analysis-category-statistics",
          uiPatterns["content-card"],
          failureAnalysisStatisticsStyles["failure-analysis-category-statistics"],
        )}
      >
        <header>
          <span>
            <BarChart3 aria-hidden="true" size={20} />
            <strong>分析结论分布</strong>
          </span>
          <time dateTime={initialPage.generatedAt}>
            统计于 {formatPlatformDateTime(initialPage.generatedAt)}
          </time>
        </header>
        <div
          className={cn(
            "failure-analysis-category-grid",
            failureAnalysisStatisticsStyles["failure-analysis-category-grid"],
          )}
        >
          <CategoryMetric
            count={summary.categories.rerunPassed}
            label="重跑通过"
            total={summary.completed}
            tone="green"
          />
          <CategoryMetric
            count={summary.categories.caseFixed}
            label="用例修复"
            total={summary.completed}
            tone="blue"
          />
          <CategoryMetric
            count={summary.categories.codeIssueFiled}
            label="代码问题提单"
            total={summary.completed}
            tone="orange"
          />
        </div>
      </Card>

      <Card
        as="section"
        className={cn(
          "content-card failure-analysis-analyst-statistics",
          uiPatterns["content-card"],
          failureAnalysisStatisticsStyles["failure-analysis-analyst-statistics"],
        )}
      >
        <header>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>People</span>
            <h2>人员认领与分析</h2>
            <p>按最近分析活动排序；点击人员可查看其逐条结论和填写内容。</p>
          </div>
        </header>
        {error && !selectedAnalyst ? (
          <Notice tone="error" className={cn("auth-error", uiPatterns["auth-error"])} role="alert">
            {error}
          </Notice>
        ) : null}
        {analysts.length === 0 ? (
          <div
            className={cn(
              "failure-analysis-empty",
              failureAnalysisStatisticsStyles["failure-analysis-empty"],
            )}
          >
            <ClipboardCheck aria-hidden="true" size={24} />
            <strong>当前范围还没有认领记录</strong>
          </div>
        ) : (
          <div
            className={cn(
              "failure-analysis-analyst-list",
              failureAnalysisStatisticsStyles["failure-analysis-analyst-list"],
            )}
          >
            {analysts.map((analyst) => (
              <Button
                className={cn(
                  "failure-analysis-analyst-row",
                  failureAnalysisStatisticsStyles["failure-analysis-analyst-row"],
                )}
                key={analyst.claimantId}
                onClick={() => void openAnalyst(analyst)}
                type="button"
              >
                <span
                  className={cn(
                    "failure-analysis-analyst-avatar",
                    failureAnalysisStatisticsStyles["failure-analysis-analyst-avatar"],
                  )}
                  aria-hidden="true"
                >
                  {analyst.claimantDisplayName.slice(0, 1).toLocaleUpperCase("zh-CN")}
                </span>
                <span
                  className={cn(
                    "failure-analysis-analyst-identity",
                    failureAnalysisStatisticsStyles["failure-analysis-analyst-identity"],
                  )}
                >
                  <strong>{analyst.claimantDisplayName}</strong>
                  <small>@{analyst.claimantUsername}</small>
                </span>
                <span>
                  <small>认领</small>
                  <strong>{analyst.total}</strong>
                </span>
                <span>
                  <small>已分析</small>
                  <strong>{analyst.completed}</strong>
                </span>
                <span>
                  <small>完成率</small>
                  <strong>{percent(analyst.completed, analyst.total)}%</strong>
                </span>
                <span>
                  <small>最近活动</small>
                  <time>{formatPlatformDateTime(analyst.lastActivityAt)}</time>
                </span>
                <ChevronRight aria-hidden="true" size={17} />
              </Button>
            ))}
          </div>
        )}
        {nextCursor ? (
          <Button disabled={loadingMore} onClick={() => void loadMoreAnalysts()} type="button">
            {loadingMore ? (
              <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
            ) : null}
            {loadingMore ? "正在加载…" : "加载更多人员"}
          </Button>
        ) : null}
      </Card>

      <ActionDialog
        className={cn(
          "failure-analysis-statistics-dialog",
          failureAnalysisStatisticsStyles["failure-analysis-statistics-dialog"],
        )}
        onClose={() => setSelectedAnalyst(undefined)}
        open={Boolean(selectedAnalyst)}
        title={selectedAnalyst ? `${selectedAnalyst.claimantDisplayName} 的分析内容` : "分析内容"}
      >
        <div
          className={cn(
            "failure-analysis-statistics-dialog-body",
            failureAnalysisStatisticsStyles["failure-analysis-statistics-dialog-body"],
          )}
        >
          {error ? (
            <Notice
              tone="error"
              className={cn("auth-error", uiPatterns["auth-error"])}
              role="alert"
            >
              {error}
            </Notice>
          ) : null}
          {claimsLoading && claims.length === 0 ? (
            <p className={"loading-inline"}>
              <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />{" "}
              正在读取分析内容…
            </p>
          ) : claims.length === 0 ? (
            <p className={cn("muted", uiPatterns["muted"])}>该人员当前没有可查看的分析内容。</p>
          ) : (
            claims.map((claim) => <ClaimConclusion claim={claim} key={claim.id} />)
          )}
          {selectedAnalyst && claimCursor ? (
            <Button
              disabled={claimsLoading}
              onClick={() => void loadClaims(selectedAnalyst, claimCursor, true)}
              type="button"
            >
              加载更多内容
            </Button>
          ) : null}
        </div>
        <div
          className={cn(
            "action-dialog-actions",
            failureAnalysisStatisticsStyles["action-dialog-actions"],
          )}
        >
          <Button onClick={() => setSelectedAnalyst(undefined)} type="button">
            <X aria-hidden="true" size={15} /> 关闭
          </Button>
        </div>
      </ActionDialog>
    </>
  );
}

function StatisticMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <Card as="article" className={cn("content-card", uiPatterns["content-card"])}>
      <Statistic title={label} value={value} />
    </Card>
  );
}

function CategoryMetric({
  count,
  label,
  total,
  tone,
}: {
  count: number;
  label: string;
  total: number;
  tone: "green" | "blue" | "orange";
}) {
  const ratio = percent(count, total);
  return (
    <article
      className={cn(
        failureAnalysisStatisticsStyles["failure-analysis-category-metric"],
        `failure-analysis-category-metric ${tone}`,
      )}
    >
      <span>
        <strong>{label}</strong>
        <b>{ratio}%</b>
      </span>
      <ProgressBar label={`${label}占比`} max={100} value={ratio} />
      <small>{count.toLocaleString("zh-CN")} 条结论</small>
    </article>
  );
}

function ClaimConclusion({ claim }: { claim: FailureAnalysisClaimView }) {
  return (
    <article
      className={cn(
        "failure-analysis-conclusion-card",
        failureAnalysisStatisticsStyles["failure-analysis-conclusion-card"],
      )}
    >
      <header>
        <span>
          <strong>{claim.caseName}</strong>
          <code>{claim.className}</code>
        </span>
        <b>{claim.category ? categoryLabel(claim.category) : statusLabel(claim.status)}</b>
      </header>
      <dl>
        <ConclusionField label="失败摘要" value={claim.failureSummary} />
        <ConclusionField label="问题描述" value={claim.issueDescription} />
        <ConclusionField label="修复证明" value={claim.caseFixEvidence} />
        <ConclusionField label="提单链接" value={claim.ticketReference} />
        <ConclusionField label="备注" value={claim.remark} />
      </dl>
      <time>{formatPlatformDateTime(claim.completedAt ?? claim.updatedAt)}</time>
    </article>
  );
}

function ConclusionField({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function percent(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 1_000) / 10;
}

function categoryLabel(category: NonNullable<FailureAnalysisClaimView["category"]>): string {
  return {
    rerun_passed: "重跑通过",
    case_fixed: "用例修复",
    code_issue_filed: "代码问题提单",
  }[category];
}

function statusLabel(status: FailureAnalysisClaimView["status"]): string {
  return { claimed: "已认领", analyzing: "分析中", completed: "已完成" }[status];
}

const failureAnalysisStatisticsStyles = {
  "action-dialog-actions": "flex justify-end gap-[9px] border-t border-solid border-border pt-4",
  "failure-analysis-analyst-avatar":
    "grid w-9 h-9 place-items-center rounded-full bg-info/10 text-info font-semibold",
  "failure-analysis-analyst-identity": "grid min-w-0 gap-[3px]",
  "failure-analysis-analyst-list":
    "grid border border-solid border-border rounded-lg overflow-hidden",
  "failure-analysis-analyst-row":
    "grid grid-cols-[42px_minmax(180px,_1.4fr)_repeat(3,_minmax(72px,_0.6fr))_minmax(150px,_1fr)_20px] items-center gap-3 min-h-18 py-3 px-4 border-0 border-b border-solid border-border bg-card text-foreground text-left cursor-pointer [&:last-child]:border-b-0 [&:hover]:bg-muted [&:focus-visible]:bg-muted [&_>_span:not(.failure-analysis-analyst-avatar)]:grid [&_>_span:not(.failure-analysis-analyst-avatar)]:min-w-0 [&_>_span:not(.failure-analysis-analyst-avatar)]:gap-[3px] [&_small]:text-muted-foreground [&_small]:text-xs [&_time]:text-muted-foreground [&_time]:text-xs max-[1181px]:grid-cols-[42px_minmax(160px,_1fr)_repeat(3,_74px)_20px] max-[1181px]:[&_>_span:nth-last-of-type(1)]:hidden",
  "failure-analysis-analyst-statistics":
    "grid gap-5 [&_.ui-card-content_>_header]:flex [&_.ui-card-content_>_header]:items-center [&_.ui-card-content_>_header]:justify-between [&_.ui-card-content_>_header]:gap-3 [&_.ui-card-content_>_header_h2]:m-0 [&_.ui-card-content_>_header_p]:m-0 [&_.ui-card-content_>_header_p]:text-muted-foreground",
  "failure-analysis-category-grid": "grid grid-cols-3 gap-4",
  "failure-analysis-category-metric":
    "grid gap-3 p-4 border border-solid border-border rounded-lg bg-muted [&_>_span]:flex [&_>_span]:justify-between [&_.ui-progress]:w-full [&_.ui-progress]:h-2 [&_.ui-progress]:overflow-hidden [&_.ui-progress]:border-0 [&_.ui-progress]:rounded-full [&_.ui-progress-fill]:bg-info [&.green_.ui-progress-fill]:bg-success [&.orange_.ui-progress-fill]:bg-warning [&_small]:text-muted-foreground",
  "failure-analysis-category-statistics":
    "grid gap-5 [&_.ui-card-content_>_header]:flex [&_.ui-card-content_>_header]:items-center [&_.ui-card-content_>_header]:justify-between [&_.ui-card-content_>_header]:gap-3 [&_.ui-card-content_>_header_>_span]:flex [&_.ui-card-content_>_header_>_span]:items-center [&_.ui-card-content_>_header_>_span]:justify-start [&_.ui-card-content_>_header_>_span]:gap-3 [&_time]:text-muted-foreground [&_time]:text-xs",
  "failure-analysis-conclusion-card":
    "grid gap-3 p-4 border border-solid border-border rounded-lg bg-muted [&_>_header]:flex [&_>_header]:items-start [&_>_header]:justify-between [&_>_header]:gap-4 [&_>_header_>_span]:grid [&_>_header_>_span]:gap-2 [&_>_header_>_span]:min-w-0 [&_dl]:grid [&_dl]:gap-2 [&_dl]:min-w-0 [&_dl]:m-0 [&_code]:text-muted-foreground [&_code]:text-xs [&_time]:text-muted-foreground [&_time]:text-xs [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:m-0 [&_dd]:whitespace-pre-wrap [&_dd]:[overflow-wrap:anywhere] [&_dl_>_div]:grid [&_dl_>_div]:gap-1",
  "failure-analysis-empty":
    "grid min-h-[190px] place-items-center [align-content:center] gap-[9px] p-7 border border-dashed border-border rounded-lg bg-muted text-muted-foreground text-center [&_strong]:text-foreground",
  "failure-analysis-stat-summary":
    "grid grid-cols-3 gap-4 [&_.ant-card]:min-h-[118px] max-[1181px]:grid-cols-2",
  "failure-analysis-statistics-dialog":
    "w-[min(960px,_calc(100vw_-_64px))] max-h-[min(820px,_calc(100vh_-_64px))]",
  "failure-analysis-statistics-dialog-body":
    "grid gap-4 min-h-[180px] max-h-[64vh] overflow-auto pr-2",
} as const;
