"use client";

import type { AnalyticsBatchComparison } from "@autoforge/contracts";
import { useState } from "react";

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

export function BatchComparisonDetails({ cases }: { cases: AnalyticsBatchComparison["cases"] }) {
  const [pageIndex, setPageIndex] = useState(0);
  const [difference, setDifference] = useState<ComparisonDifferenceFilter>("all");
  const [leftOutcome, setLeftOutcome] = useState<ComparisonOutcomeFilter>("all");
  const [rightOutcome, setRightOutcome] = useState<ComparisonOutcomeFilter>("all");
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
    <div className="insight-detail-content">
      <div className="insight-comparison-filters" aria-label="批次对比筛选">
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
        <span aria-hidden="true" className="insight-comparison-filter-arrow">
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
      <div className="insight-detail-table-scroll">
        <table className="data-table insight-comparison-table">
          <thead>
            <tr>
              <th>用例</th>
              <th>版本变化</th>
              <th>结果变化</th>
              <th>耗时变化</th>
            </tr>
          </thead>
          <tbody>
            {visibleCases.map((item) => (
              <tr key={item.caseDefinitionId}>
                <td title={`${item.displayName} · ${item.caseDefinitionId}`}>
                  {item.displayName}
                  <small className="table-secondary">{item.caseDefinitionId}</small>
                </td>
                <td>
                  {item.leftVersion ?? "—"} → {item.rightVersion ?? "—"}
                </td>
                <td>
                  {comparisonOutcomeLabel(item.leftOutcome)} →{" "}
                  {comparisonOutcomeLabel(item.rightOutcome)}
                </td>
                <td>
                  {item.durationDeltaMs === undefined
                    ? "—"
                    : `${item.durationDeltaMs >= 0 ? "+" : ""}${item.durationDeltaMs} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCases.length === 0 ? (
          <div className="inline-empty">
            {cases.length === 0 ? "两个批次没有可对比用例。" : "没有符合当前条件的用例。"}
          </div>
        ) : null}
      </div>
      {filteredCases.length > 0 ? (
        <nav aria-label="批次对比明细分页" className="insight-detail-pagination">
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
    </div>
  );
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
