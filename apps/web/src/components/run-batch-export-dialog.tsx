"use client";

import type { ExportOutcomeFilter } from "@autoforge/contracts";
import { Download, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, Input } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import {
  buildRunBatchExportQuery,
  DEFAULT_EXPORT_OUTCOMES,
  EXPORT_OUTCOME_OPTIONS,
  parseExportFilename,
  type RunBatchExportScope,
} from "@/lib/run-batch-export";

/**
 * 轮次执行结果导出弹窗。只持有导出表单状态；下载通过 Blob + a[download] 触发，
 * 文件名以服务端 Content-Disposition 为准。
 */
export function RunBatchExportDialog({
  batchId,
  round,
  roundLabelText,
  defaultScope,
  onClose,
}: {
  batchId: string;
  /** 从具体轮次打开时提供；全部轮次虚拟视图打开时缺省，隐藏「当前轮次」选项。 */
  round?: number | undefined;
  roundLabelText?: string | undefined;
  defaultScope?: RunBatchExportScope;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<RunBatchExportScope>(defaultScope ?? "round");
  const [selectedOutcomes, setSelectedOutcomes] = useState<ReadonlySet<ExportOutcomeFilter>>(
    () => new Set(DEFAULT_EXPORT_OUTCOMES),
  );
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function toggleOutcome(outcome: ExportOutcomeFilter): void {
    setSelectedOutcomes((current) => {
      const next = new Set(current);
      if (next.has(outcome)) {
        next.delete(outcome);
      } else {
        next.add(outcome);
      }
      return next;
    });
  }

  const hasSelection = selectedOutcomes.size > 0;

  async function exportResults(): Promise<void> {
    if (!hasSelection || exporting) return;
    setExporting(true);
    setError("");
    try {
      const query = buildRunBatchExportQuery(scope, round, [...selectedOutcomes]);
      const response = await fetch(
        `/api/v1/run-batches/${encodeURIComponent(batchId)}/export?${query}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "导出执行结果失败。"))!);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = parseExportFilename(response.headers.get("content-disposition"));
      // Firefox 要求触发下载的元素挂在 DOM 上；click 同步派发后即可移除并回收。
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      onClose();
    } catch (exportFailure) {
      setError(exportFailure instanceof Error ? exportFailure.message : "导出执行结果失败。");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="runner-update-overlay" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="导出执行结果"
        aria-modal="true"
        className="runner-update-dialog export-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="runner-update-titlebar">
          <span>
            <Download size={16} aria-hidden="true" />
            <strong>导出执行结果</strong>
            <small>Excel（.xlsx）</small>
          </span>
          <Button aria-label="关闭" onClick={onClose} type="button">
            <X size={16} />
          </Button>
        </header>
        <div className="runner-update-body">
          <fieldset className="export-dialog-group">
            <legend>导出范围</legend>
            {round !== undefined ? (
              <label className="export-dialog-option">
                <Input
                  checked={scope === "round"}
                  name="export-scope"
                  onChange={() => setScope("round")}
                  type="radio"
                />
                <span>
                  当前轮次
                  <small>
                    {roundLabelText}（第 {round} 轮）
                  </small>
                </span>
              </label>
            ) : null}
            <label className="export-dialog-option">
              <Input
                checked={scope === "all"}
                name="export-scope"
                onChange={() => setScope("all")}
                type="radio"
              />
              <span>
                全部轮次
                <small>逐条记录，标注轮次；同一用例多条记录会分行导出</small>
              </span>
            </label>
            <label className="export-dialog-option">
              <Input
                checked={scope === "final"}
                name="export-scope"
                onChange={() => setScope("final")}
                type="radio"
              />
              <span>
                最终结果
                <small>每个用例最终结果</small>
              </span>
            </label>
          </fieldset>
          <fieldset className="export-dialog-group">
            <legend>结果类型</legend>
            {EXPORT_OUTCOME_OPTIONS.map((option) => (
              <label className="export-dialog-option" key={option.value}>
                <Input
                  checked={selectedOutcomes.has(option.value)}
                  onChange={() => toggleOutcome(option.value)}
                  type="checkbox"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          {!hasSelection ? (
            <p className="export-dialog-hint" role="status">
              请至少选择一种结果类型后再导出。
            </p>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="runner-installer-actions">
            <Button
              className="button-primary"
              disabled={!hasSelection || exporting}
              onClick={() => void exportResults()}
              type="button"
            >
              {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{" "}
              {exporting ? "正在导出..." : "导出 Excel"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
