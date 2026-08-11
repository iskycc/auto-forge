"use client";

import type { SystemDiagnostic } from "@autoforge/contracts";
import { Download, RefreshCw, Stethoscope } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export function SystemDiagnostics() {
  const [diagnostic, setDiagnostic] = useState<SystemDiagnostic>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    const pendingRefresh = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(pendingRefresh);
  }, [refresh]);

  return (
    <section className="content-card settings-section" aria-busy={loading}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Diagnostics</p>
          <h2>系统诊断</h2>
        </div>
        <Stethoscope size={22} aria-hidden="true" />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading && !diagnostic ? <div className="inline-empty">正在执行有界健康检查…</div> : null}
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
        </>
      ) : null}
      <div className="settings-form-actions">
        <button
          className="button button-secondary"
          disabled={loading}
          onClick={() => void refresh()}
          type="button"
        >
          <RefreshCw size={16} /> 刷新诊断
        </button>
        <a className="button button-secondary" href="/api/v1/settings/diagnostics?download=1">
          <Download size={16} /> 下载脱敏诊断包
        </a>
      </div>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024 ** 3) return `${(value / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1_024 ** 3).toFixed(1)} GiB`;
}
