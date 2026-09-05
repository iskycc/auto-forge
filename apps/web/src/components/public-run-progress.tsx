"use client";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import { CheckCircle2, CircleAlert, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import type { RunProgress } from "@/lib/run-progress";

export function PublicRunProgress({
  initial,
  accessToken,
  permanent = false,
  statisticsPending = false,
}: {
  initial: RunProgress;
  accessToken: string;
  permanent?: boolean;
  statisticsPending?: boolean;
}) {
  const [pending, setPending] = useState(statisticsPending);
  const [progress, setProgress] = useState(initial);
  const [refreshError, setRefreshError] = useState("");

  useEffect(() => {
    if (!progress.active && !pending) return;
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/v1/run-batches/${encodeURIComponent(progress.batchId)}/progress?access_token=${encodeURIComponent(accessToken)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setProgress((await response.json()) as RunProgress);
        setRefreshError("");
        setPending(false);
      } catch {
        setRefreshError("进度刷新暂时失败，页面将在下一周期自动重试。");
      }
    };
    if (pending) void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [accessToken, pending, progress.active, progress.batchId]);

  const completionPercent =
    progress.totalCases === 0
      ? 0
      : Math.min(100, Math.round((progress.completedCases / progress.totalCases) * 100));
  const StatusIcon = progress.active
    ? LoaderCircle
    : progress.statusLabel === "执行完成"
      ? CheckCircle2
      : CircleAlert;

  return (
    <main className="public-progress-page">
      <section className="public-progress-card">
        <header>
          <div>
            <span className="eyebrow">AUTOFORGE EXECUTION</span>
            <h1>{progress.suiteName}</h1>
            <p>{permanent ? "永久只读结果" : "只读执行进展"} · 每 30 秒自动刷新</p>
          </div>
          <span className={`public-progress-status status-${progress.status}`}>
            <StatusIcon className={progress.active ? "spin" : ""} size={20} />
            {progress.statusLabel}
          </span>
        </header>

        <div className="public-progress-bar" aria-label={`完成 ${completionPercent}%`}>
          <span style={{ width: `${completionPercent}%` }} />
        </div>
        <div className="public-progress-percent">
          <strong>{pending ? "统计准备中" : `${completionPercent}%`}</strong>
          <span>
            {pending ? "—" : progress.completedCases} / {progress.totalCases} 个用例已结束
          </span>
        </div>

        <dl className="public-progress-metrics">
          <div>
            <dt>当前轮次</dt>
            <dd>
              第 {progress.currentRound} / {progress.maximumRounds} 轮
            </dd>
          </div>
          <div>
            <dt>本轮通过</dt>
            <dd>{progress.currentRoundPassed}</dd>
          </div>
          <div>
            <dt>累计通过</dt>
            <dd>{progress.totalPassed}</dd>
          </div>
          <div>
            <dt>最终失败</dt>
            <dd>{progress.finalFailed}</dd>
          </div>
        </dl>

        <footer>
          <span>批次 {progress.batchId}</span>
          <span>
            <RotateCw size={13} /> 更新于 {formatPlatformDateTime(progress.updatedAt)}
          </span>
        </footer>
        {refreshError ? <p className="form-error">{refreshError}</p> : null}
      </section>
    </main>
  );
}
