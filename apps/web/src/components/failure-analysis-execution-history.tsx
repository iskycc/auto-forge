"use client";

import {
  failureAnalysisExecutionHistorySchema,
  type FailureAnalysisClaimView,
  type FailureAnalysisExecution,
} from "@autoforge/contracts";
import { GitCompareArrows, History, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { sharedOutcomeLabel, sharedOutcomeClass } from "@/lib/shared-attempt-log";

export type AnalysisLogComparison = {
  claim: FailureAnalysisClaimView;
  execution: FailureAnalysisExecution;
};

export function FailureAnalysisExecutionHistory({
  claims,
  projectId,
  onCompare,
}: {
  claims: FailureAnalysisClaimView[];
  projectId: string;
  onCompare: (comparison: AnalysisLogComparison) => void;
}) {
  const [selectedId, setSelectedId] = useState(claims[0]?.id);
  const selectedClaim = claims.find((claim) => claim.id === selectedId) ?? claims[0];
  if (!selectedClaim) return null;
  return (
    <section className="analysis-execution-history" aria-label="前 5 次执行结果">
      <header>
        <div>
          <h3>
            <History size={16} aria-hidden="true" /> 前 5 次执行
          </h3>
          <p>同一任务、同一用例，每个已结束的历史批次取最终结果，按执行时间倒序。</p>
        </div>
        {claims.length > 1 ? (
          <Select
            aria-label="选择查看执行历史的用例"
            value={selectedClaim.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {claims.map((claim) => (
              <option key={claim.id} value={claim.id}>
                {claim.caseName} · {claim.className}
              </option>
            ))}
          </Select>
        ) : null}
      </header>
      <ExecutionHistoryResults
        key={selectedClaim.id}
        claim={selectedClaim}
        projectId={projectId}
        onCompare={onCompare}
      />
    </section>
  );
}

function ExecutionHistoryResults({
  claim,
  projectId,
  onCompare,
}: {
  claim: FailureAnalysisClaimView;
  projectId: string;
  onCompare: (comparison: AnalysisLogComparison) => void;
}) {
  const [items, setItems] = useState<FailureAnalysisExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function loadHistory() {
      try {
        const query = new URLSearchParams({ projectId, analysisId: claim.id });
        const response = await fetch(`/api/v1/failure-analysis/executions?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, "读取执行历史失败。"));
        const history = failureAnalysisExecutionHistorySchema.parse(await response.json());
        if (!controller.signal.aborted) setItems(history.items);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "读取执行历史失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadHistory();
    return () => controller.abort();
  }, [claim.id, projectId, revision]);
  if (loading) return <p role="status">正在读取该用例的前 5 次执行结果…</p>;
  if (error)
    return (
      <div className="analysis-history-error" role="alert">
        <span>{error}</span>
        <Button
          size="compact"
          type="button"
          onClick={() => {
            setError("");
            setLoading(true);
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw size={14} /> 重新加载历史
        </Button>
      </div>
    );
  if (!items.length) return <p role="status">该用例在此任务中暂无更早的执行结果。</p>;
  return (
    <table className="analysis-execution-table">
      <caption className="visually-hidden">{claim.caseName}的前 5 次执行结果</caption>
      <thead>
        <tr>
          <th>执行批次 / 时间</th>
          <th>结果</th>
          <th>用例版本</th>
          <th>结果摘要</th>
          <th>日志</th>
        </tr>
      </thead>
      <tbody>
        {items.map((execution) => (
          <tr key={execution.executionRunId}>
            <td>
              <a
                href={`/run-batches/${encodeURIComponent(execution.batchId)}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`查看执行批次 #${execution.batchSequenceNumber}（新标签页）`}
              >
                #{execution.batchSequenceNumber}
              </a>
              <time dateTime={execution.createdAt} title={`UTC ${execution.createdAt}`}>
                {formatPlatformDateTime(execution.createdAt)}
              </time>
            </td>
            <td>
              <span className={`batch-status ${sharedOutcomeClass(execution.outcome)}`}>
                {sharedOutcomeLabel(execution.outcome)}
              </span>
            </td>
            <td>
              v{execution.caseVersion}
              <small>
                {execution.attemptNumber ? `第 ${execution.attemptNumber} 次尝试` : "未启动执行"}
              </small>
            </td>
            <td>
              <span className="analysis-execution-summary" title={execution.resultSummary}>
                {execution.resultSummary || "暂无结果摘要"}
              </span>
            </td>
            <td>
              <Button
                size="compact"
                type="button"
                variant="secondary"
                disabled={!execution.attemptId}
                title={
                  execution.attemptId
                    ? "与本次分析的日志对比"
                    : "该次执行未产生执行尝试，无日志可对比"
                }
                onClick={() => onCompare({ claim, execution })}
              >
                <GitCompareArrows size={14} /> 日志对比
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
