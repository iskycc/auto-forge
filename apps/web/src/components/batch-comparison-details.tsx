"use client";
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

import type { AnalyticsBatchComparison } from "@autoforge/contracts";
import { GitCompareArrows } from "lucide-react";
import { useState } from "react";

import { AttemptLogComparison, type AttemptLogComparisonSelection } from "./attempt-log-comparison";
import { Button, Select } from "./ui";

const COMPARISON_DETAIL_PAGE_SIZE = 50;
const OUTCOME_FILTER_OPTIONS = [
  { value: "all", label: "全部结果" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
  { value: "timed_out", label: "已超时" },
  { value: "missing", label: "无此用例" },
] as const;

export type ComparisonOutcomeFilter = (typeof OUTCOME_FILTER_OPTIONS)[number]["value"];
export type ComparisonDifferenceFilter = "all" | "different";

export function filterBatchComparisonCases(
  cases: AnalyticsBatchComparison["cases"],
  filters: {
    difference: ComparisonDifferenceFilter;
    leftOutcome: ComparisonOutcomeFilter;
    rightOutcome: ComparisonOutcomeFilter;
  },
): AnalyticsBatchComparison["cases"] {
  return cases.filter(
    (item) =>
      (filters.difference === "all" || item.leftOutcome !== item.rightOutcome) &&
      matchesOutcome(item.leftOutcome, filters.leftOutcome) &&
      matchesOutcome(item.rightOutcome, filters.rightOutcome),
  );
}

export function BatchComparisonDetails({
  cases,
  left,
  right,
}: {
  cases: AnalyticsBatchComparison["cases"];
  left: AnalyticsBatchComparison["left"];
  right: AnalyticsBatchComparison["right"];
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const [difference, setDifference] = useState<ComparisonDifferenceFilter>("all");
  const [leftOutcome, setLeftOutcome] = useState<ComparisonOutcomeFilter>("all");
  const [rightOutcome, setRightOutcome] = useState<ComparisonOutcomeFilter>("all");
  const [logComparison, setLogComparison] = useState<AttemptLogComparisonSelection>();
  const filteredCases = filterBatchComparisonCases(cases, {
    difference,
    leftOutcome,
    rightOutcome,
  });
  const pageCount = Math.max(1, Math.ceil(filteredCases.length / COMPARISON_DETAIL_PAGE_SIZE));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const start = safePageIndex * COMPARISON_DETAIL_PAGE_SIZE;
  const visibleCases = filteredCases.slice(start, start + COMPARISON_DETAIL_PAGE_SIZE);

  function updateFilter(update: () => void): void {
    setPageIndex(0);
    update();
  }

  return (
    <div
      className={cn(
        "insight-detail-content",
        batchComparisonDetailsStyles["insight-detail-content"],
      )}
    >
      <div
        className={cn(
          "insight-comparison-filters",
          batchComparisonDetailsStyles["insight-comparison-filters"],
        )}
        aria-label="批次对比筛选"
      >
        <label>
          <span>对比范围</span>
          <Select
            aria-label="对比范围"
            onChange={(event) =>
              updateFilter(() => setDifference(event.target.value as ComparisonDifferenceFilter))
            }
            value={difference}
          >
            <option value="all">全部用例</option>
            <option value="different">仅显示结果不同</option>
          </Select>
        </label>
        <label>
          <span>左侧批次结果</span>
          <Select
            aria-label="左侧批次结果"
            onChange={(event) =>
              updateFilter(() => setLeftOutcome(event.target.value as ComparisonOutcomeFilter))
            }
            value={leftOutcome}
          >
            {OUTCOME_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <span
          aria-hidden="true"
          className={cn(
            "insight-comparison-filter-arrow",
            batchComparisonDetailsStyles["insight-comparison-filter-arrow"],
          )}
        >
          →
        </span>
        <label>
          <span>右侧批次结果</span>
          <Select
            aria-label="右侧批次结果"
            onChange={(event) =>
              updateFilter(() => setRightOutcome(event.target.value as ComparisonOutcomeFilter))
            }
            value={rightOutcome}
          >
            {OUTCOME_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <small>
          已显示 {filteredCases.length} / {cases.length} 个用例
        </small>
      </div>
      <div
        className={cn(
          "insight-detail-table-scroll",
          batchComparisonDetailsStyles["insight-detail-table-scroll"],
        )}
      >
        <Table
          className={cn(
            "data-table insight-comparison-table",
            uiPatterns["data-table"],
            batchComparisonDetailsStyles["insight-comparison-table"],
          )}
        >
          <TableHeader>
            <TableRow>
              <TableHead>用例</TableHead>
              <TableHead>版本变化</TableHead>
              <TableHead>结果变化</TableHead>
              <TableHead>耗时变化</TableHead>
              <TableHead>执行日志</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleCases.map((item) => (
              <TableRow key={item.caseDefinitionId}>
                <TableCell title={`${item.displayName} · ${item.caseDefinitionId}`}>
                  {item.displayName}
                  <small className={cn("table-secondary", uiPatterns["table-secondary"])}>
                    {item.caseDefinitionId}
                  </small>
                </TableCell>
                <TableCell>
                  {item.leftVersion ?? "—"} → {item.rightVersion ?? "—"}
                </TableCell>
                <TableCell>
                  {comparisonOutcomeLabel(item.leftOutcome)} →{" "}
                  {comparisonOutcomeLabel(item.rightOutcome)}
                </TableCell>
                <TableCell>
                  {item.durationDeltaMs === undefined
                    ? "—"
                    : `${item.durationDeltaMs >= 0 ? "+" : ""}${item.durationDeltaMs} ms`}
                </TableCell>
                <TableCell>
                  <Button
                    aria-label={`对比 ${item.displayName} 的两次执行日志`}
                    className={cn(
                      "insight-comparison-log-button",
                      batchComparisonDetailsStyles["insight-comparison-log-button"],
                    )}
                    disabled={!item.leftAttemptId || !item.rightAttemptId}
                    onClick={() =>
                      setLogComparison({
                        name: item.displayName,
                        context: `${item.displayName} · ${item.className}`,
                        left: {
                          attemptId: item.leftAttemptId,
                          title: "基准批次日志",
                          subtitle: batchAttemptSubtitle(
                            left.sequenceNumber,
                            item.leftOutcome,
                            item.leftAttemptNumber,
                          ),
                        },
                        right: {
                          attemptId: item.rightAttemptId,
                          title: "对比批次日志",
                          subtitle: batchAttemptSubtitle(
                            right.sequenceNumber,
                            item.rightOutcome,
                            item.rightAttemptNumber,
                          ),
                        },
                      })
                    }
                    size="compact"
                    title={
                      item.leftAttemptId && item.rightAttemptId
                        ? "对比该用例在两个批次中的执行日志"
                        : "其中一个批次没有执行尝试，暂无两侧日志可对比"
                    }
                    type="button"
                    variant="secondary"
                  >
                    <GitCompareArrows aria-hidden="true" size={14} /> 日志对比
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {filteredCases.length === 0 ? (
          <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
            {cases.length === 0 ? "两个批次没有可对比用例。" : "没有符合当前条件的用例。"}
          </div>
        ) : null}
      </div>
      {filteredCases.length > 0 ? (
        <nav
          aria-label="批次对比明细分页"
          className={cn(
            "insight-detail-pagination",
            batchComparisonDetailsStyles["insight-detail-pagination"],
          )}
        >
          <span>
            第 {start + 1}–{Math.min(start + COMPARISON_DETAIL_PAGE_SIZE, filteredCases.length)}{" "}
            项，共 {filteredCases.length} 项
          </span>
          <div>
            <Button
              disabled={safePageIndex === 0}
              onClick={() => setPageIndex(Math.max(0, safePageIndex - 1))}
              size="compact"
              type="button"
            >
              上一页
            </Button>
            <Button
              disabled={safePageIndex + 1 >= pageCount}
              onClick={() => setPageIndex(Math.min(pageCount - 1, safePageIndex + 1))}
              size="compact"
              type="button"
            >
              下一页
            </Button>
          </div>
        </nav>
      ) : null}
      {logComparison ? (
        <AttemptLogComparison
          comparison={logComparison}
          onClose={() => setLogComparison(undefined)}
        />
      ) : null}
    </div>
  );
}

function batchAttemptSubtitle(
  sequenceNumber: number,
  outcome: string | undefined,
  attemptNumber: number | undefined,
): string {
  return `批次 #${sequenceNumber} · ${comparisonOutcomeLabel(outcome)} · ${attemptNumber ? `第 ${attemptNumber} 次尝试` : "执行尝试"}`;
}

function comparisonOutcomeLabel(outcome: string | undefined): string {
  if (!outcome) return "—";
  switch (outcome) {
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "timed_out":
      return "已超时";
    default:
      return outcome;
  }
}

function matchesOutcome(outcome: string | undefined, filter: ComparisonOutcomeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "missing") return outcome === undefined;
  return outcome === filter;
}

const batchComparisonDetailsStyles = {
  "insight-comparison-filter-arrow": "mb-2.5 text-muted-foreground",
  "insight-comparison-filters":
    "flex [flex:0_0_auto] flex-wrap items-end gap-2 [&_>_label]:grid [&_>_label]:min-w-[150px] [&_>_label]:gap-1 [&_>_label]:text-muted-foreground [&_>_label]:text-xs [&_>_label]:font-semibold [&_>_small]:[margin:0_0_9px_auto] [&_>_small]:text-muted-foreground",
  "insight-comparison-log-button": "whitespace-nowrap",
  "insight-comparison-table":
    "min-w-0! [table-layout:fixed] [&_th:first-child]:w-[30%] [&_th:last-child]:w-[116px] [&_td:first-child]:text-ellipsis [&_td:first-child]:whitespace-nowrap [&_.table-secondary]:inline [&_.table-secondary]:ml-2",
  "insight-detail-content": "flex w-full min-h-0 flex-col gap-3",
  "insight-detail-pagination":
    "flex [flex:0_0_auto] items-center justify-between gap-3 text-muted-foreground text-xs [&_>_div]:flex [&_>_div]:gap-2",
  "insight-detail-table-scroll":
    "w-full min-h-0 [flex:1_1_auto] overflow-x-hidden overflow-y-auto [overscroll-behavior:contain] border border-solid border-border rounded-xl [scrollbar-gutter:stable] [&_.data-table]:w-full [&_.data-table]:min-w-0 [&_.data-table]:[table-layout:fixed] [&_.data-table_th]:sticky [&_.data-table_th]:z-1 [&_.data-table_th]:top-0 [&_.data-table_th]:shadow-xs [&_.data-table_td]:py-[13px] [&_.data-table_td]:leading-[1.5] [&_.data-table_td]:overflow-hidden [&_.data-table_td]:text-ellipsis [&_.data-table_td]:whitespace-nowrap [&_.data-table_tbody_tr:nth-child(even)]:bg-muted [&_.insight-comparison-table_th]:py-1 [&_.insight-comparison-table_th]:leading-[1.3] [&_.insight-comparison-table_td]:py-1 [&_.insight-comparison-table_td]:leading-[1.3] [&_.insight-comparison-table_th:last-child]:px-2 [&_.insight-comparison-table_td:last-child]:px-2",
} as const;
