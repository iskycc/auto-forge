"use client";

import type { AnalyticsBatchComparison } from "@autoforge/contracts";
import { useState } from "react";

import { Button } from "./ui";

const COMPARISON_DETAIL_PAGE_SIZE = 50;

export function BatchComparisonDetails({ cases }: { cases: AnalyticsBatchComparison["cases"] }) {
  const [pageIndex, setPageIndex] = useState(0);
  const pageCount = Math.max(1, Math.ceil(cases.length / COMPARISON_DETAIL_PAGE_SIZE));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const start = safePageIndex * COMPARISON_DETAIL_PAGE_SIZE;
  const visibleCases = cases.slice(start, start + COMPARISON_DETAIL_PAGE_SIZE);

  return (
    <div className="insight-detail-content">
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
        {cases.length === 0 ? <div className="inline-empty">两个批次没有可对比用例。</div> : null}
      </div>
      {cases.length > 0 ? (
        <nav aria-label="批次对比明细分页" className="insight-detail-pagination">
          <span>
            第 {start + 1}–{Math.min(start + COMPARISON_DETAIL_PAGE_SIZE, cases.length)} 项，共{" "}
            {cases.length} 项
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
