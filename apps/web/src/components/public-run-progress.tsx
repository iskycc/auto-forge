"use client";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

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
    <main className={cn("public-progress-page", publicRunProgressStyles["public-progress-page"])}>
      <section
        className={cn("public-progress-card", publicRunProgressStyles["public-progress-card"])}
      >
        <header>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>AUTOFORGE EXECUTION</span>
            <h1>{progress.suiteName}</h1>
            <p>{permanent ? "永久只读结果" : "只读执行进展"} · 每 30 秒自动刷新</p>
          </div>
          <span
            className={cn(
              publicRunProgressStyles["status"],
              publicRunProgressStyles["public-progress-status"],
              `public-progress-status status status-${progress.status}`,
            )}
          >
            <StatusIcon
              className={progress.active ? cn("spin", uiPatterns["spin"]) : ""}
              size={20}
            />
            {progress.statusLabel}
          </span>
        </header>

        <div
          className={cn("public-progress-bar", publicRunProgressStyles["public-progress-bar"])}
          aria-label={`完成 ${completionPercent}%`}
        >
          <span style={{ width: `${completionPercent}%` }} />
        </div>
        <div
          className={cn(
            "public-progress-percent",
            publicRunProgressStyles["public-progress-percent"],
          )}
        >
          <strong>{pending ? "统计准备中" : `${completionPercent}%`}</strong>
          <span>
            {pending ? "—" : progress.completedCases} / {progress.totalCases} 个用例已结束
          </span>
        </div>

        <dl
          className={cn(
            "public-progress-metrics",
            publicRunProgressStyles["public-progress-metrics"],
          )}
        >
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
        {refreshError ? (
          <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
            {refreshError}
          </Notice>
        ) : null}
      </section>
    </main>
  );
}

const publicRunProgressStyles = {
  "public-progress-bar":
    "h-2.5 mt-9 overflow-hidden rounded-full bg-muted [&_>_span]:block [&_>_span]:h-full [&_>_span]:rounded-xl [&_>_span]:bg-info [&_>_span]:transition-colors [&_>_span]:duration-150 [&_>_span]:motion-reduce:transition-none",
  "public-progress-card":
    "w-[min(920px,_100%)] p-9 border border-solid border-border rounded-xl bg-card shadow-xs [&_>_header]:flex [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-4 [&_>_footer]:flex [&_>_footer]:items-center [&_>_footer]:justify-between [&_>_footer]:gap-4 [&_>_footer]:pt-5 [&_>_footer]:border-t [&_>_footer]:border-solid [&_>_footer]:border-border [&_>_footer]:text-muted-foreground [&_>_footer]:text-xs [&_h1]:my-2 [&_h1]:mx-0 [&_p]:text-muted-foreground [&_>_footer_span]:inline-flex [&_>_footer_span]:items-center [&_>_footer_span]:gap-1.5",
  "public-progress-metrics":
    "grid grid-cols-4 gap-3 my-7.5 mx-0 [&_>_div]:p-4.5 [&_>_div]:border [&_>_div]:border-solid [&_>_div]:border-border [&_>_div]:rounded-lg [&_>_div]:bg-muted [&_dt]:text-muted-foreground [&_dt]:text-sm [&_dd]:[margin:8px_0_0] [&_dd]:text-2xl [&_dd]:font-semibold",
  "public-progress-page": "min-h-screen grid place-items-center p-12 bg-card",
  "public-progress-percent":
    "flex items-center justify-between gap-4 mt-3 text-muted-foreground [&_strong]:text-foreground [&_strong]:text-2xl",
  "public-progress-status": "flex items-center justify-start gap-4 font-semibold whitespace-nowrap",
  status:
    "[&.status-badge]:inline-flex [&.status-badge]:w-fit [&.status-badge]:items-center [&.status-badge]:gap-[5px] [&.status-badge]:rounded-full [&.status-badge]:py-[5px] [&.status-badge]:px-2 [&.status-badge]:text-xs [&.status-badge]:font-semibold [&.status-badge]:whitespace-nowrap [&.status-ready]:bg-success/10 [&.status-ready]:text-success [&.status-muted]:bg-muted [&.status-muted]:text-muted-foreground [&.status-warning]:[margin:0_0_10px] [&.status-warning]:border [&.status-warning]:border-solid [&.status-warning]:border-transparent [&.status-warning]:rounded-lg [&.status-warning]:py-2 [&.status-warning]:px-2.5 [&.status-warning]:text-warning [&.status-warning]:bg-warning/10 [&.status-warning]:text-xs",
} as const;
