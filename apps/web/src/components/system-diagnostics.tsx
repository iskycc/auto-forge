"use client";
import { Notice } from "@/components/ui/notice";

import { LinkButton } from "@/components/ui/link-button";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { systemDiagnosticSchema, type SystemDiagnostic } from "@autoforge/contracts";
import { Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { LoadingState } from "@/components/loading-state";
import { useConfirm, useToast } from "@/components/ui-feedback";
import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";
import { DiagnosticPanels } from "./system-diagnostic-panels";
import { DiagnosticDeadLetters } from "./system-diagnostic-dead-letters";
import styles from "./system-diagnostics.styles";

const CACHE_KEY = "system-diagnostics:v2";

export function SystemDiagnostics({ canManage }: { canManage: boolean }) {
  const confirmAction = useConfirm();
  const toast = useToast();
  const [diagnostic, setDiagnostic] = useState<SystemDiagnostic>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [redriving, setRedriving] = useState(false);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async (force = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const epoch = browserCacheEpoch();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/settings/diagnostics${force ? "?refresh=1" : ""}`, {
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "系统诊断读取失败。");
      const next = systemDiagnosticSchema.parse(body);
      if (!controller.signal.aborted && epoch === browserCacheEpoch()) {
        setDiagnostic(next);
        writeBrowserSnapshot(CACHE_KEY, next, epoch);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error && cause.name !== "TimeoutError"
            ? cause.message
            : "诊断请求超时，请稍后刷新。",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const pending = window.setTimeout(() => {
      const cached = systemDiagnosticSchema.safeParse(readBrowserSnapshot(CACHE_KEY));
      if (cached.success) setDiagnostic(cached.data);
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(pending);
      request.current?.abort();
    };
  }, [refresh]);

  async function redriveDeadLetters(): Promise<void> {
    if (
      !(await confirmAction({
        title: "重新投递死信任务",
        description:
          "本次最多重新投递 100 个死信任务，从第 1 次投递重新执行。请确认故障原因已经处理。",
        confirmLabel: "重新投递",
        tone: "danger",
      }))
    )
      return;
    setRedriving(true);
    try {
      const response = await fetch("/api/v1/settings/diagnostics", {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "重新投递死信失败。");
      toast.success(`已重新投递 ${body.redriven ?? 0} 个死信任务。`);
      await refresh(true);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "重新投递死信失败。");
    } finally {
      setRedriving(false);
    }
  }

  return (
    <section className={styles.page} aria-label="平台诊断报告" aria-busy={loading}>
      <div className={styles.toolbar}>
        <p aria-live="polite">
          {loading ? (
            "正在更新诊断快照…"
          ) : diagnostic ? (
            <>
              更新于{" "}
              <time dateTime={diagnostic.generatedAt} title={`UTC ${diagnostic.generatedAt}`}>
                {new Date(diagnostic.generatedAt).toLocaleString("zh-CN")}
              </time>
            </>
          ) : (
            "诊断尚未完成"
          )}
        </p>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={loading || redriving}
            onClick={() => void refresh(true)}
            type="button"
          >
            <RefreshCw size={15} />
            刷新诊断
          </Button>
          <LinkButton
            className={cn(
              "button button-secondary",
              uiPatterns["button"],
              uiPatterns["button-secondary"],
            )}
            href="/api/v1/settings/diagnostics?download=1"
          >
            <Download size={15} />
            下载脱敏诊断包
          </LinkButton>
        </div>
      </div>
      {error ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
          {error}
          {diagnostic ? " 当前保留上次诊断结果，请留意更新时间。" : ""}
        </Notice>
      ) : null}
      {loading && !diagnostic ? (
        <LoadingState
          label="正在执行健康检查"
          description="正在检查数据库、对象存储、队列与缓存状态。"
        />
      ) : null}
      {diagnostic ? (
        <>
          <DiagnosticPanels diagnostic={diagnostic} />
          <DiagnosticDeadLetters
            diagnostic={diagnostic}
            canManage={canManage}
            redriving={redriving}
            loading={loading}
            redriveDeadLetters={redriveDeadLetters}
          />
        </>
      ) : null}
    </section>
  );
}
