"use client";

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
      className="failure-analysis-conclusion-case"
      data-case-id={latest.claim.caseDefinitionId}
    >
      <header className="failure-analysis-conclusion-case-heading">
        <strong title={latest.claim.caseName}>{latest.claim.caseName}</strong>
        <code title={latest.claim.className}>{latest.claim.className}</code>
      </header>
      <ConclusionDetails item={latest} onSelect={onSelect} latest />
      {conclusionCount > 1 ? (
        <Button
          aria-controls={historyId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"} ${latest.claim.caseName} 的其他分析结论`}
          className="failure-analysis-conclusion-toggle"
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
        <div className="failure-analysis-conclusion-history" id={historyId}>
          <small>近 5 次批跑中的其他分析结论</small>
          {loading ? (
            <p className="failure-analysis-history-state" role="status">
              <LoaderCircle className="spin" size={16} /> 正在读取历史结论…
            </p>
          ) : null}
          {error ? (
            <div className="failure-analysis-conclusion-load-error" role="alert">
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
      className="failure-analysis-conclusion-entry"
      aria-label={`${latest ? "最近结论" : "历史结论"} · 批次 #${item.batchSequenceNumber}`}
    >
      <div className="failure-analysis-conclusion-entry-content">
        <div className="failure-analysis-conclusion-meta">
          <span className="analysis-status completed">{category}</span>
          <small>
            {latest ? "最近一次分析" : "历史分析"} · #{item.batchSequenceNumber} {item.batchName}
          </small>
        </div>
        <p className="failure-analysis-conclusion-summary" title={claim.failureSummary}>
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
          <p className="failure-analysis-conclusion-ticket">
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
