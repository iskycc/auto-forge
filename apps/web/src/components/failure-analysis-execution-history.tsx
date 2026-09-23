"use client";
import { Badge } from "@/components/ui/badge";

import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import {
  failureAnalysisExecutionHistorySchema,
  type FailureAnalysisClaimView,
  type FailureAnalysisExecution,
} from "@autoforge/contracts";
import { GitCompareArrows, History, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import type { AttemptLogComparisonSelection } from "@/components/attempt-log-comparison";
import { Button, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { sharedOutcomeLabel, sharedOutcomeClass } from "@/lib/shared-attempt-log";

export type AnalysisLogComparison = AttemptLogComparisonSelection;

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
    <section
      className={cn(
        "analysis-execution-history",
        failureAnalysisExecutionHistoryStyles["analysis-execution-history"],
      )}
      aria-label="前 5 次执行结果"
    >
      <header>
        <div>
          <h3>
            <History size={16} aria-hidden="true" /> 前 5 次执行
          </h3>
          <small>同一任务、同一用例 · 最近 5 个批次的最终结果</small>
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
      <div
        className={cn(
          "analysis-history-error",
          failureAnalysisExecutionHistoryStyles["analysis-history-error"],
        )}
        role="alert"
      >
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
    <Table
      className={cn(
        "analysis-execution-table",
        failureAnalysisExecutionHistoryStyles["analysis-execution-table"],
      )}
    >
      <caption className={cn("visually-hidden", uiPatterns["visually-hidden"])}>
        {claim.caseName}的前 5 次执行结果
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead>执行批次 / 时间</TableHead>
          <TableHead>结果</TableHead>
          <TableHead>用例版本</TableHead>
          <TableHead>结果摘要</TableHead>
          <TableHead>日志</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((execution) => (
          <TableRow key={execution.executionRunId}>
            <TableCell>
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
            </TableCell>
            <TableCell>
              <Badge
                className={cn(
                  failureAnalysisExecutionHistoryStyles["batch-status"],
                  `batch-status ${sharedOutcomeClass(execution.outcome)}`,
                )}
              >
                {sharedOutcomeLabel(execution.outcome)}
              </Badge>
            </TableCell>
            <TableCell>
              v{execution.caseVersion}
              <small>
                {execution.attemptNumber ? `第 ${execution.attemptNumber} 次尝试` : "未启动执行"}
              </small>
            </TableCell>
            <TableCell>
              <span
                className={cn(
                  "analysis-execution-summary",
                  failureAnalysisExecutionHistoryStyles["analysis-execution-summary"],
                )}
                title={execution.resultSummary}
              >
                {execution.resultSummary || "暂无结果摘要"}
              </span>
            </TableCell>
            <TableCell>
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
                onClick={() =>
                  onCompare({
                    name: claim.caseName,
                    context: `${claim.caseName} · ${claim.className}`,
                    left: {
                      attemptId: execution.attemptId,
                      title: "历史日志",
                      subtitle: `批次 #${execution.batchSequenceNumber} · ${sharedOutcomeLabel(execution.outcome)} · ${formatPlatformDateTime(execution.createdAt)}`,
                    },
                    right: {
                      attemptId: claim.attemptId,
                      title: "本次分析日志",
                      subtitle: `第 ${claim.attemptNumber} 次尝试 · 失败 · ${claim.caseName}`,
                    },
                  })
                }
              >
                <GitCompareArrows size={14} /> 日志对比
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const failureAnalysisExecutionHistoryStyles = {
  "analysis-execution-history":
    "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 py-2 px-3 border border-solid border-border rounded-lg bg-card [&_>_header]:flex [&_>_header]:min-w-0 [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-3 [&_h3]:flex [&_h3]:items-center [&_h3]:gap-2 [&_h3]:m-0 [&_h3]:text-sm [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-xs [&_p]:py-1 [&_p]:min-h-0 [&_>_header_>_.ui-select]:w-[38%] [&_>_header_>_.ui-select]:shrink-0 [&_>_header_small]:text-muted-foreground [&_>_header_small]:text-xs [&_>_header_>_div:first-child]:flex [&_>_header_>_div:first-child]:items-baseline [&_>_header_>_div:first-child]:flex-wrap [&_>_header_>_div:first-child]:gap-2",
  "analysis-execution-summary":
    "[display:-webkit-box] [-webkit-line-clamp:2] [-webkit-box-orient:vertical] overflow-hidden [overflow-wrap:anywhere]",
  "analysis-execution-table":
    "[&_small]:m-0 [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:block [&_small]:leading-[1.7] [&_time]:m-0 [&_time]:text-muted-foreground [&_time]:text-xs [&_time]:block [&_time]:leading-[1.7] w-full [table-layout:fixed] [border-collapse:collapse] text-xs [&_th]:p-2 [&_th]:border-b [&_th]:border-solid [&_th]:border-border [&_th]:text-left [&_th]:[vertical-align:middle] [&_th]:bg-muted [&_th]:text-muted-foreground [&_th]:font-medium [&_td]:p-2 [&_td]:border-b [&_td]:border-solid [&_td]:border-border [&_td]:text-left [&_td]:[vertical-align:middle] [&_th:first-child]:w-[25%] [&_th:nth-child(2)]:w-[10%] [&_th:nth-child(3)]:w-[13%] [&_th:last-child]:w-[16%] [&_tr:last-child_td]:border-b-0 [&_a]:text-info [&_a]:font-semibold",
  "analysis-history-error": "flex items-center justify-between gap-3 text-destructive text-sm",
  "batch-status": uiPatterns["batch-status"],
} as const;
