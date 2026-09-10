import type { PublicPlatformStatistics } from "@autoforge/contracts";
import { Activity, CheckCircle2, Clock3, RefreshCw, Server } from "lucide-react";
import type { CSSProperties } from "react";

import { formatPlatformTime } from "@/lib/platform-date-time";
import { Button } from "./ui";
import styles from "./public-dashboard.module.css";

export function publicSnapshotPresentation(
  statistics: PublicPlatformStatistics,
  syncFailed: boolean,
) {
  const hasStatistics =
    statistics.snapshotState !== "pending" && statistics.snapshotState !== "failed";
  if (syncFailed)
    return {
      hasStatistics,
      tone: "warning",
      label: hasStatistics ? "同步中断，保留上次统计" : "同步中断，请稍后重试",
    };
  if (statistics.snapshotState === "failed")
    return { hasStatistics, tone: "warning", label: "统计暂时不可用" };
  if (statistics.snapshotState === "pending")
    return { hasStatistics, tone: "neutral", label: "统计正在生成" };
  if (statistics.snapshotState === "stale")
    return { hasStatistics, tone: "warning", label: "统计待刷新，显示上次快照" };
  return { hasStatistics, tone: "success", label: "公开统计已更新" };
}

export function PublicControlPreview({
  statistics,
  syncFailed,
  synchronizing,
  onRefresh,
}: {
  statistics: PublicPlatformStatistics;
  syncFailed: boolean;
  synchronizing: boolean;
  onRefresh: () => void;
}) {
  const status = publicSnapshotPresentation(statistics, syncFailed);
  const count = (value: number) => (status.hasStatistics ? value.toLocaleString("zh-CN") : "—");

  return (
    <section className={styles.preview} aria-label="平台实时运行概况">
      <header className={styles.previewHeader}>
        <div>
          <span className={styles.previewMark}>
            <Activity aria-hidden="true" size={18} />
          </span>
          <strong>平台运行概况</strong>
          <small>公开概览</small>
        </div>
        <Button
          className={styles.refresh}
          variant="ghost"
          size="compact"
          type="button"
          aria-label="刷新公开统计"
          title="刷新公开统计"
          onClick={onRefresh}
          disabled={synchronizing}
        >
          <RefreshCw aria-hidden="true" size={16} className={synchronizing ? "spin" : undefined} />
        </Button>
      </header>
      <div className={styles.previewContent}>
        <div
          className={styles.snapshotStatus}
          data-tone={status.tone}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <i aria-hidden="true" />
          {synchronizing ? "正在同步公开统计" : status.label}
        </div>
        <div className={styles.previewKpis}>
          <div>
            <span>
              <Activity aria-hidden="true" size={14} />
              活动批次
            </span>
            <strong>{count(statistics.activeBatchCount)}</strong>
            <small>排队与执行中</small>
          </div>
          <div>
            <span>
              <CheckCircle2 aria-hidden="true" size={14} />
              已结束批次
            </span>
            <strong>{count(statistics.completedBatchCount)}</strong>
            <small>含成功、失败与取消</small>
          </div>
          <div>
            <span>
              <Server aria-hidden="true" size={14} />
              在线执行机
            </span>
            <strong>
              {count(statistics.onlineRunnerCount)}
              <em> / {count(statistics.runnerCount)}</em>
            </strong>
            <small>
              {status.hasStatistics
                ? count(statistics.busyRunnerCount) + " 台忙碌"
                : "等待统计快照"}
            </small>
          </div>
        </div>
        <ExecutionOutcomes statistics={statistics} hasStatistics={status.hasStatistics} />
        <div className={styles.previewFooter}>
          <span>
            <Clock3 aria-hidden="true" size={13} />
            {status.hasStatistics ? (
              <time dateTime={statistics.generatedAt} title={"UTC " + statistics.generatedAt}>
                快照 {formatPlatformTime(statistics.generatedAt)}
              </time>
            ) : (
              "等待首次统计"
            )}
          </span>
          <span>每 {statistics.refreshSeconds} 秒同步</span>
        </div>
      </div>
    </section>
  );
}

function ExecutionOutcomes({
  statistics,
  hasStatistics,
}: {
  statistics: PublicPlatformStatistics;
  hasStatistics: boolean;
}) {
  const completedCount = statistics.succeededRunCount + statistics.failedRunCount;
  const hasOutcomes = hasStatistics && statistics.totalRunCount > 0;
  const succeededShare = hasOutcomes
    ? (statistics.succeededRunCount / statistics.totalRunCount) * 100
    : 0;
  const failedShare = hasOutcomes
    ? (statistics.failedRunCount / statistics.totalRunCount) * 100
    : 0;
  const otherCount = Math.max(0, statistics.totalRunCount - completedCount);
  const outcomes = [
    { label: "成功", count: statistics.succeededRunCount, tone: "success" },
    { label: "失败 / 超时", count: statistics.failedRunCount, tone: "danger" },
    { label: "其他状态", count: otherCount, tone: "neutral" },
  ];

  return (
    <section className={styles.outcomes} aria-label="执行结果分布">
      <header>
        <h2>执行结果分布</h2>
        <span>
          {hasStatistics
            ? statistics.totalRunCount.toLocaleString("zh-CN") + " 次执行"
            : "等待数据"}
        </span>
      </header>
      <div className={styles.outcomeBody}>
        <div
          className={styles.outcomeRing}
          style={
            {
              "--succeeded-share": succeededShare + "%",
              "--completed-share": succeededShare + failedShare + "%",
            } as CSSProperties
          }
        >
          <div>
            <strong aria-label="执行成功率">
              {hasStatistics && completedCount > 0 ? statistics.successRatePercent + "%" : "—"}
            </strong>
            <span>执行成功率</span>
          </div>
        </div>
        <dl className={styles.outcomeLegend}>
          {outcomes.map((outcome) => (
            <div key={outcome.tone}>
              <dt>
                <i aria-hidden="true" data-tone={outcome.tone} />
                {outcome.label}
              </dt>
              <dd>{hasStatistics ? outcome.count.toLocaleString("zh-CN") : "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className={styles.outcomeNote}>
        {!hasStatistics
          ? "统计就绪后显示结果，当前不计作零值。"
          : !hasOutcomes
            ? "暂无执行记录，完成首次执行后呈现结果。"
            : "成功率仅计成功、失败与超时；其他含未结束及取消。"}
      </p>
    </section>
  );
}
