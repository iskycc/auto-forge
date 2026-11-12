"use client";

import { Card, Empty, Tag, Typography, theme } from "antd";
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
  const { token } = theme.useToken();
  const cardStyles = {
    body: { display: "flex", flexDirection: "column" as const, flex: 1, gap: token.margin },
  };
  const summary =
    typeof round === "number"
      ? batch.roundSummaries.find((entry) => entry.round === round)
      : undefined;
  if (typeof round === "number" && !summary)
    return (
      <section aria-label="执行结果图表">
        <Card size="small">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本轮统计暂未生成" />
        </Card>
      </section>
    );
  const totals = round === "all" ? batch.allRoundsSummary : batch.finalSummary;
  const passed = summary?.passed ?? totals.passed;
  const failed = summary?.failed ?? totals.failed;
  const timedOut = summary?.timedOut ?? totals.timedOut;
  const cancelled = summary?.cancelled ?? totals.cancelled;
  const total = summary?.totalRuns ?? totals.totalRuns;
  const notExecuted = summary?.notExecuted ?? totals.notExecuted;
  const executed = summary?.executed ?? Math.max(0, total - notExecuted);
  const inProgress = Math.max(0, executed - passed - failed - timedOut - cancelled);
  const overallPassed = summary?.overallPassed ?? batch.finalSummary.passed;
  const overallPassRate = summary?.overallPassRate ?? batch.finalSummary.passRate;
  const scope = summary ? "本轮用例" : round === "all" ? "累计执行数" : "批次用例";
  const segments: DonutChartSegment[] = [
    { label: "通过", value: passed, color: token.colorSuccess },
    { label: "失败", value: failed, color: token.colorError },
    { label: "超时", value: timedOut, color: token.colorWarning },
    { label: "进行中", value: inProgress, color: token.colorInfo },
    { label: "取消", value: cancelled, color: token.colorTextQuaternary },
    { label: "未执行", value: notExecuted, color: token.colorBorder },
  ];
  return (
    <section aria-label="执行结果图表" className="round-donuts grid min-w-0 grid-cols-2 gap-4">
      <Card
        size="small"
        className="min-w-0"
        style={{ display: "flex", flexDirection: "column" }}
        styles={cardStyles}
        title={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span>{label} · 结果分布</span>
            <Tag className="!m-0" color="blue">
              {summary ? "本轮范围" : round === "all" ? "全部轮次" : "去重总结"}
            </Tag>
          </div>
        }
      >
        <DonutChart
          size="large"
          segments={segments}
          centerValue={String(total)}
          centerLabel={scope}
          ariaLabel={`${label}结果分布：通过 ${passed}，失败 ${failed}，超时 ${timedOut}，进行中 ${inProgress}，取消 ${cancelled}，未执行 ${notExecuted}`}
        />
        <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <span>
            {scope} {total.toLocaleString()} 个
          </span>
          <span>
            已开始 {executed.toLocaleString()} · 未执行 {notExecuted.toLocaleString()}
          </span>
        </div>
      </Card>
      <Card
        size="small"
        className="min-w-0"
        style={{ display: "flex", flexDirection: "column" }}
        styles={cardStyles}
        title={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span>总体通过进度</span>
            <Tag className="!m-0">批次范围</Tag>
          </div>
        }
      >
        <DonutChart
          size="large"
          progressPercent={overallPassRate}
          segments={[
            { label: "累计通过", value: overallPassed, color: token.colorSuccess },
            {
              label: "未通过",
              value: Math.max(0, batch.totalRuns - overallPassed),
              color: token.colorBorder,
            },
          ]}
          centerValue={`${overallPassRate}%`}
          centerLabel="累计通过率"
          ariaLabel={`总体通过进度：累计通过 ${overallPassed} 个用例，共 ${batch.totalRuns} 个`}
        />
        <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs">
          <Typography.Text type="secondary" className="!text-xs">
            {summary ? `截至第 ${summary.round} 轮，按批次用例去重` : "按批次用例去重统计"}
          </Typography.Text>
          <span className="text-muted-foreground">
            批次总数 {batch.totalRuns.toLocaleString()} 个
          </span>
        </div>
      </Card>
    </section>
  );
}
