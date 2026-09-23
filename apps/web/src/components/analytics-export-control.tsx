"use client";
import { LinkButton } from "@/components/ui/link-button";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button } from "@/components/ui";
import { createClientIdempotencyKey } from "@/lib/client-idempotency-key";

import type { AnalyticsExportJob, AnalyticsFilter } from "@autoforge/contracts";
import { Download, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

type Props = { filter: AnalyticsFilter };

export function AnalyticsExportControl({ filter }: Props) {
  const [job, setJob] = useState<AnalyticsExportJob>();
  const [error, setError] = useState("");
  const active =
    job?.status === "queued" || job?.status === "running" || job?.status === "cancel_requested";

  useEffect(() => {
    if (!active || !job) return;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/v1/analytics/exports/${encodeURIComponent(job.id)}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(await responseMessage(response));
        setJob((await response.json()) as AnalyticsExportJob);
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "读取导出进度失败。");
      }
    }, 1_000);
    return () => window.clearTimeout(timeout);
  }, [active, job]);

  async function start(): Promise<void> {
    setError("");
    try {
      const response = await fetch("/api/v1/analytics/exports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": createClientIdempotencyKey(),
        },
        body: JSON.stringify({ filter, format: "csv" }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setJob((await response.json()) as AnalyticsExportJob);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "创建导出任务失败。");
    }
  }

  async function cancel(): Promise<void> {
    if (!job) return;
    setError("");
    try {
      const response = await fetch(
        `/api/v1/analytics/exports/${encodeURIComponent(job.id)}/cancel`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await responseMessage(response));
      setJob((await response.json()) as AnalyticsExportJob);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "取消导出失败。");
    }
  }

  return (
    <div
      className={cn(
        "analytics-export-control",
        analyticsExportControlStyles["analytics-export-control"],
      )}
      aria-live="polite"
    >
      {!job || ["failed", "cancelled"].includes(job.status) ? (
        <Button
          className={cn(
            "button button-secondary",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
          )}
          onClick={() => void start()}
          type="button"
        >
          <Download size={17} /> 导出当前范围
        </Button>
      ) : null}
      {active ? (
        <div
          className={cn(
            "analytics-export-progress",
            analyticsExportControlStyles["analytics-export-progress"],
          )}
        >
          <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={17} aria-hidden="true" />
          <span>正在生成 {job.progressPercent}%</span>
          <Button
            className={cn("icon-button", uiPatterns["icon-button"])}
            onClick={() => void cancel()}
            title="取消导出"
            type="button"
          >
            <X size={16} />
          </Button>
        </div>
      ) : null}
      {job?.status === "succeeded" ? (
        <LinkButton
          className={cn(
            "button button-secondary",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
          )}
          href={`/api/v1/analytics/exports/${encodeURIComponent(job.id)}/download`}
        >
          <Download size={17} /> 下载 {job.rowCount ?? 0} 行
        </LinkButton>
      ) : null}
      {job?.status === "failed" ? (
        <span
          className={cn("field-error", analyticsExportControlStyles["field-error"])}
          role="alert"
        >
          {job.errorSummary ?? "导出生成失败。"}
        </span>
      ) : null}
      {job?.status === "cancelled" ? (
        <span className={cn("muted", uiPatterns["muted"])}>导出已取消。</span>
      ) : null}
      {error ? (
        <span
          className={cn("field-error", analyticsExportControlStyles["field-error"])}
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

async function responseMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => undefined)) as
    { error?: { message?: string } } | undefined;
  return body?.error?.message ?? `请求失败（${response.status}）。`;
}

const analyticsExportControlStyles = {
  "analytics-export-control": "flex items-center gap-2 flex-wrap",
  "analytics-export-progress":
    "flex items-center gap-2 flex-wrap min-h-9 [padding:0_8px_0_12px] border border-solid border-border rounded-lg bg-card text-muted-foreground text-sm",
  "field-error": "text-destructive text-xs leading-[1.5]",
} as const;
