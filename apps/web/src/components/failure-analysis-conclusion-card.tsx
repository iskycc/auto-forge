"use client";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import {
  failureAnalysisHistoryPageSchema,
  type FailureAnalysisCaseConclusionView,
  type FailureAnalysisHistoryItemView,
} from "@autoforge/contracts";
import { ChevronDown, ChevronUp, LoaderCircle } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { readApiErrorMessage } from "@/lib/client-api";

import { Button } from "./ui";

export function FailureAnalysisConclusionCard({
  group,
  projectId,
  batchId,
  onSelect,
}: {
  group: FailureAnalysisCaseConclusionView;
  projectId: string;
  batchId: string;
  onSelect: (item: FailureAnalysisHistoryItemView) => void;
}) {
  const { latest, conclusionCount } = group;
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<FailureAnalysisHistoryItemView[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const historyId = useId();

  useEffect(() => {
    if (!expanded || history) return;
    const controller = new AbortController();
    const deferredLoad = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const parameters = new URLSearchParams({
          projectId,
          batchId,
          caseDefinitionId: latest.claim.caseDefinitionId,
          scope: "task_recent_batches",
          view: "case_history",
        });
        const response = await fetch(`/api/v1/failure-analysis/conclusions?${parameters}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error((await readApiErrorMessage(response, "读取该用例历史结论失败。"))!);
        }
        const page = failureAnalysisHistoryPageSchema.parse(await response.json());
        if (!controller.signal.aborted) setHistory(page.items);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "读取该用例历史结论失败。");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 0);
    return () => {
      window.clearTimeout(deferredLoad);
      controller.abort();
    };
  }, [batchId, expanded, history, latest.claim.caseDefinitionId, projectId, retry]);

  const olderConclusions = history?.filter((item) => item.claim.id !== latest.claim.id) ?? [];
  return (
    <article
      className={cn(
        "failure-analysis-conclusion-case",
        failureAnalysisConclusionCardStyles["failure-analysis-conclusion-case"],
      )}
      data-case-id={latest.claim.caseDefinitionId}
    >
      <header
        className={cn(
          "failure-analysis-conclusion-case-heading",
          failureAnalysisConclusionCardStyles["failure-analysis-conclusion-case-heading"],
        )}
      >
        <strong title={latest.claim.caseName}>{latest.claim.caseName}</strong>
        <code title={latest.claim.className}>{latest.claim.className}</code>
      </header>
      <ConclusionDetails item={latest} onSelect={onSelect} latest />
      {conclusionCount > 1 ? (
        <Button
          aria-controls={historyId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"} ${latest.claim.caseName} 的其他分析结论`}
          className={cn(
            "failure-analysis-conclusion-toggle",
            failureAnalysisConclusionCardStyles["failure-analysis-conclusion-toggle"],
          )}
          onClick={() => setExpanded((current) => !current)}
          size="compact"
          type="button"
          variant="secondary"
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? "收起其他结论" : `展开其他结论（${conclusionCount - 1}）`}
        </Button>
      ) : null}
      {expanded ? (
        <div
          className={cn(
            "failure-analysis-conclusion-history",
            failureAnalysisConclusionCardStyles["failure-analysis-conclusion-history"],
          )}
          id={historyId}
        >
          <small>近 5 次批跑中的其他分析结论</small>
          {loading ? (
            <p
              className={cn(
                "failure-analysis-history-state",
                failureAnalysisConclusionCardStyles["failure-analysis-history-state"],
              )}
              role="status"
            >
              <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={16} />{" "}
              正在读取历史结论…
            </p>
          ) : null}
          {error ? (
            <div
              className={cn(
                "failure-analysis-conclusion-load-error",
                failureAnalysisConclusionCardStyles["failure-analysis-conclusion-load-error"],
              )}
              role="alert"
            >
              <p>{error}</p>
              <Button
                onClick={() => setRetry((current) => current + 1)}
                size="compact"
                type="button"
              >
                重试
              </Button>
            </div>
          ) : null}
          {!loading && !error && history && olderConclusions.length === 0 ? (
            <p>暂无其他可继承结论，请重新搜索以刷新列表。</p>
          ) : null}
          {olderConclusions.map((item) => (
            <ConclusionDetails item={item} key={item.claim.id} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ConclusionDetails({
  item,
  latest = false,
  onSelect,
}: {
  item: FailureAnalysisHistoryItemView;
  latest?: boolean;
  onSelect: (item: FailureAnalysisHistoryItemView) => void;
}) {
  const { claim } = item;
  const category = claim.category
    ? {
        rerun_passed: "重跑通过",
        case_fixed: "用例问题已修改",
        code_issue_filed: "代码问题已提单",
      }[claim.category]
    : "已完成";
  return (
    <section
      className={cn(
        "failure-analysis-conclusion-entry",
        failureAnalysisConclusionCardStyles["failure-analysis-conclusion-entry"],
      )}
      aria-label={`${latest ? "最近结论" : "历史结论"} · 批次 #${item.batchSequenceNumber}`}
    >
      <div
        className={cn(
          "failure-analysis-conclusion-entry-content",
          failureAnalysisConclusionCardStyles["failure-analysis-conclusion-entry-content"],
        )}
      >
        <div
          className={cn(
            "failure-analysis-conclusion-meta",
            failureAnalysisConclusionCardStyles["failure-analysis-conclusion-meta"],
          )}
        >
          <span
            className={cn(
              "analysis-status completed",
              failureAnalysisConclusionCardStyles["analysis-status"],
            )}
          >
            {category}
          </span>
          <small>
            {latest ? "最近一次分析" : "历史分析"} · #{item.batchSequenceNumber} {item.batchName}
          </small>
        </div>
        <p
          className={cn(
            "failure-analysis-conclusion-summary",
            failureAnalysisConclusionCardStyles["failure-analysis-conclusion-summary"],
          )}
          title={claim.failureSummary}
        >
          {claim.failureSummary}
        </p>
        {claim.issueDescription ? <p>{claim.issueDescription}</p> : null}
        {claim.caseFixEvidence ? (
          <p>
            <b>修改证明：</b>
            {claim.caseFixEvidence}
          </p>
        ) : null}
        {claim.category === "code_issue_filed" ? (
          <p
            className={cn(
              "failure-analysis-conclusion-ticket",
              failureAnalysisConclusionCardStyles["failure-analysis-conclusion-ticket"],
            )}
          >
            <b>问题单：</b>
            {claim.ticketReference && /^https?:\/\//iu.test(claim.ticketReference) ? (
              <a href={claim.ticketReference} target="_blank" rel="noopener noreferrer">
                {claim.ticketReference}
              </a>
            ) : (
              claim.ticketReference || "未记录问题单"
            )}
          </p>
        ) : null}
        {claim.remark ? (
          <p>
            <b>备注：</b>
            {claim.remark}
          </p>
        ) : null}
      </div>
      <Button
        aria-label={
          latest ? `选择并继承 ${claim.caseName}` : `继承批次 #${item.batchSequenceNumber} 的结论`
        }
        onClick={() => onSelect(item)}
        size="compact"
        type="button"
        variant="primary"
      >
        {latest ? "选择并继承" : "继承此结论"}
      </Button>
    </section>
  );
}

const failureAnalysisConclusionCardStyles = {
  "analysis-status":
    "inline-flex max-w-full [flex:0_0_auto] flex-wrap items-center gap-[5px] py-[3px] px-[7px] rounded-full bg-muted text-muted-foreground text-xs font-semibold [&.available]:bg-info/10 [&.available]:text-info [&.claimed]:bg-warning/10 [&.claimed]:text-warning [&.analyzing]:bg-info/10 [&.analyzing]:text-info [&.completed]:bg-success/10 [&.completed]:text-success [&_small]:overflow-hidden [&_small]:max-w-full [&_small]:text-inherit! [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
  "failure-analysis-conclusion-case":
    "min-w-0 grid gap-2 border border-solid border-border rounded-lg p-3 bg-muted",
  "failure-analysis-conclusion-case-heading":
    "grid min-w-0 gap-1 [&_strong]:[display:-webkit-box] [&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal [&_strong]:[-webkit-box-orient:vertical] [&_strong]:[-webkit-line-clamp:2] [&_code]:[display:-webkit-box] [&_code]:min-w-0 [&_code]:overflow-hidden [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-normal [&_code]:[-webkit-box-orient:vertical] [&_code]:[-webkit-line-clamp:2] [&_code]:text-muted-foreground [&_code]:text-xs",
  "failure-analysis-conclusion-entry":
    "grid grid-cols-[minmax(0,_1fr)_auto] items-start gap-3 min-w-0",
  "failure-analysis-conclusion-entry-content":
    "min-w-0 grid gap-2 [overflow-wrap:anywhere] text-sm [&_p]:min-w-0 [&_p]:m-0 [&_p]:whitespace-pre-wrap",
  "failure-analysis-conclusion-history":
    "[&_>_small]:text-muted-foreground [&_>_small]:text-xs grid min-w-0 gap-3 border-t border-solid border-border pt-3 [&_.failure-analysis-conclusion-entry]:border [&_.failure-analysis-conclusion-entry]:border-solid [&_.failure-analysis-conclusion-entry]:border-border [&_.failure-analysis-conclusion-entry]:rounded-lg [&_.failure-analysis-conclusion-entry]:p-2 [&_.failure-analysis-conclusion-entry]:bg-card",
  "failure-analysis-conclusion-load-error": "flex items-center gap-2 text-destructive",
  "failure-analysis-conclusion-meta":
    "[&_small]:text-muted-foreground [&_small]:text-xs flex flex-wrap items-center gap-2 min-w-0",
  "failure-analysis-conclusion-summary":
    "text-muted-foreground text-xs [display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:3]",
  "failure-analysis-conclusion-ticket":
    "col-span-full min-w-0 [margin:4px_0_0] p-2 rounded-lg bg-muted text-sm [overflow-wrap:anywhere] whitespace-normal [&_a]:text-primary-text [&_a]:[text-decoration:underline]",
  "failure-analysis-conclusion-toggle": "justify-self-start",
  "failure-analysis-history-state":
    "flex min-h-13.5 items-center justify-center gap-[7px] border border-dashed border-border rounded-lg text-muted-foreground text-sm [&.error]:[border-color:color-mix(in_srgb,_var(--destructive)_28%,_var(--border))] [&.error]:text-destructive",
} as const;
