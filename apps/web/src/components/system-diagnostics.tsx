"use client";

import { Button } from "@/components/ui";
import { LoadingState } from "@/components/loading-state";
import { useConfirm, useToast } from "@/components/ui-feedback";

import type { SystemDiagnostic } from "@autoforge/contracts";
import { Download, RefreshCw, RotateCcw, Stethoscope } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export function SystemDiagnostics({ canManage }: { canManage: boolean }) {
  const confirmAction = useConfirm();
  const toast = useToast();
  const [diagnostic, setDiagnostic] = useState<SystemDiagnostic>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [redriving, setRedriving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/v1/settings/diagnostics", { cache: "no-store" });
      const body = (await response.json()) as SystemDiagnostic & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "系统诊断读取失败。");
      setDiagnostic(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "系统诊断读取失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  async function redriveDeadLetters(): Promise<void> {
    if (
      !(await confirmAction({
        title: "重新投递死信任务",
        description: "当前死信任务会从第 1 次投递重新执行，请确认故障原因已经处理。",
        confirmLabel: "重新投递",
        tone: "danger",
      }))
    )
      return;
    setRedriving(true);
    setError("");
    try {
      const response = await fetch("/api/v1/settings/diagnostics", { method: "POST" });
      const body = (await response.json()) as {
        redriven?: number;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "重新投递死信失败。");
      toast.success(`已重新投递 ${body.redriven ?? 0} 个死信任务。`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重新投递死信失败。");
    } finally {
      setRedriving(false);
    }
  }

  useEffect(() => {
    const pendingRefresh = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(pendingRefresh);
  }, [refresh]);

  return (
    <section className="content-card settings-section" aria-busy={loading}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Diagnostics</p>
          <h2>诊断结果</h2>
        </div>
        <Stethoscope size={22} aria-hidden="true" />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading && !diagnostic ? (
        <LoadingState
          label="正在执行健康检查"
          description="正在检查数据库、对象存储、队列与缓存状态。"
        />
      ) : null}
      {diagnostic ? (
        <>
          <div className="diagnostic-summary">
            <span>AutoForge {diagnostic.version}</span>
            <span>{diagnostic.mode.toUpperCase()}</span>
            <span>配置修订 {diagnostic.configurationRevision}</span>
            <span>UTC {diagnostic.generatedAt}</span>
          </div>
          <div className="diagnostic-grid">
            {Object.entries({
              数据库: diagnostic.database,
              对象存储: diagnostic.objectStore,
              任务队列: diagnostic.queue,
              缓存: diagnostic.cache,
            }).map(([label, status]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{status.ready ? "就绪" : "异常"}</strong>
                <small>{status.detail}</small>
              </div>
            ))}
            <div>
              <span>平台数据卷</span>
              <strong>
                {diagnostic.dataDisk.status === "ok"
                  ? "正常"
                  : diagnostic.dataDisk.status === "warning"
                    ? "容量预警"
                    : "容量严重"}
              </strong>
              <small>
                已用 {diagnostic.dataDisk.usedPercent}% · 可用{" "}
                {formatBytes(diagnostic.dataDisk.availableBytes)}
              </small>
            </div>
          </div>
          {diagnostic.recentErrors.length > 0 ? (
            <ul className="diagnostic-errors">
              {diagnostic.recentErrors.map((item) => (
                <li key={`${item.timestamp}-${item.code}`}>
                  <strong>{item.code}</strong> · {item.summary}
                </li>
              ))}
            </ul>
          ) : (
            <div className="inline-success">本次诊断未发现依赖错误或队列死信。</div>
          )}
          {diagnostic.deadLetters.length > 0 ? (
            <div className="diagnostic-dead-letters">
              <div className="section-heading">
                <div>
                  <h3>死信任务</h3>
                  <p>保留最后一次失败原因；确认问题已修复后可重新投递。</p>
                </div>
                {canManage ? (
                  <Button
                    disabled={redriving || loading}
                    onClick={() => void redriveDeadLetters()}
                    type="button"
                    variant="secondary"
                  >
                    <RotateCcw size={15} /> {redriving ? "正在重新投递…" : "重新投递全部"}
                  </Button>
                ) : null}
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>任务类型</th>
                      <th>关联对象</th>
                      <th>失败原因</th>
                      <th>投递次数</th>
                      <th>失败时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diagnostic.deadLetters.map((deadLetter) => (
                      <tr key={deadLetter.messageId}>
                        <td>{queueJobKindLabel(deadLetter.kind)}</td>
                        <td>
                          <code title={deadLetter.runId}>{shortId(deadLetter.runId)}</code>
                        </td>
                        <td>
                          <strong>{deadLetter.errorCode}</strong>
                          <small className="table-secondary">{deadLetter.errorSummary}</small>
                        </td>
                        <td>{deadLetter.deliveryAttempts}</td>
                        <td>
                          <time dateTime={deadLetter.failedAt}>
                            {formatDate(deadLetter.failedAt)}
                          </time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <div className="settings-form-actions">
        <Button
          className="button button-secondary"
          disabled={loading}
          onClick={() => void refresh()}
          type="button"
        >
          <RefreshCw size={16} /> 刷新诊断
        </Button>
        <a className="button button-secondary" href="/api/v1/settings/diagnostics?download=1">
          <Download size={16} /> 下载脱敏诊断包
        </a>
      </div>
    </section>
  );
}

function queueJobKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    "dispatch-run": "执行调度",
    "ldap-sync": "历史 LDAP 同步（已停用）",
    "analytics-rollup": "质量统计",
    "retention-cleanup": "数据清理",
    "object-cleanup": "对象清理",
    "jar-import": "JAR 导入",
    "analytics-export": "质量导出",
    "ddt-import": "DDT 导入",
  };
  return labels[kind] ?? kind;
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1_024 ** 3) return `${(value / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1_024 ** 3).toFixed(1)} GiB`;
}
