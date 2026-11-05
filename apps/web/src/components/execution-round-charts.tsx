"use client";

import { DonutChart, type DonutChartSegment } from "./donut-chart";
import type { ExecutionBatchView } from "@/lib/execution-batch-view";

export function ExecutionRoundCharts({
  batch,
  round,
  label,
}: {
  batch: ExecutionBatchView;
  round: number | "all" | "summary";
  label: string;
}) {
  const summary =
    typeof round === "number"
      ? batch.roundSummaries.find((entry) => entry.round === round)
      : undefined;
  const totals = round === "all" ? batch.allRoundsSummary : batch.finalSummary;
  const passed = summary?.passed ?? totals.passed;
  const failed = summary?.failed ?? totals.failed;
  const timedOut = summary?.timedOut ?? totals.timedOut;
  const cancelled = summary?.cancelled ?? totals.cancelled;
  const inProgress = summary
    ? Math.max(0, summary.executed - passed - failed - timedOut - cancelled)
    : 0;
  const notExecuted = summary
    ? Math.max(0, batch.totalRuns - summary.executed)
    : totals.notExecuted;
  const executed = summary?.executed ?? Math.max(0, totals.totalRuns - totals.notExecuted);
  const overallPassed = summary?.overallPassed ?? batch.finalSummary.passed;
  const overallPassRate = summary?.overallPassRate ?? batch.finalSummary.passRate;
  const resultSegments: DonutChartSegment[] = [
    { label: "通过", value: passed, color: "var(--success)" },
    { label: "失败", value: failed, color: "var(--destructive)" },
    { label: "超时", value: timedOut, color: "var(--warning)" },
    { label: "进行中", value: inProgress, color: "var(--info)" },
    { label: "取消", value: cancelled, color: "var(--muted-foreground)" },
    { label: "未执行", value: notExecuted, color: "var(--input)" },
  ];
  return (
    <section
      aria-label="执行结果图表"
      className="round-donuts grid min-w-0 grid-cols-2 gap-4 rounded-xl border border-border bg-card p-4 shadow-xs"
    >
      <div className={chartPanelClassName}>
        <h3 className="m-0 text-sm font-medium">{label} · 结果分布</h3>
        <DonutChart
          size="large"
          segments={resultSegments}
          centerValue={String(executed)}
          centerLabel="已执行"
          ariaLabel={`${label}结果分布：通过 ${passed}，失败 ${failed}，超时 ${timedOut}，进行中 ${inProgress}，取消 ${cancelled}，未执行 ${notExecuted}`}
        />
      </div>
      <div className={chartPanelClassName}>
        <h3 className="m-0 text-sm font-medium">总体通过进度</h3>
        <DonutChart
          size="large"
          segments={[
            { label: "累计通过", value: overallPassed, color: "var(--success)" },
            {
              label: "未通过",
              value: Math.max(0, batch.totalRuns - overallPassed),
              color: "var(--input)",
            },
          ]}
          centerValue={`${overallPassRate}%`}
          centerLabel="总通过率"
          ariaLabel={`总体通过进度：累计通过 ${overallPassed} 个用例，共 ${batch.totalRuns} 个`}
        />
      </div>
    </section>
  );
}

const chartPanelClassName =
  "grid min-w-0 gap-2 rounded-lg bg-muted/40 px-4 py-3 [&_.round-donut]:justify-center [&_.round-donut]:gap-3 [&_.round-donut-legend]:min-w-0 [&_.round-donut-legend-item]:whitespace-normal";
