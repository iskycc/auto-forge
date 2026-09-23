"use client";
import { Notice } from "@/components/ui/notice";

import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { ExportOutcomeFilter, RunBatchExportTemplate } from "@autoforge/contracts";
import { Download, LoaderCircle, X } from "lucide-react";
import { useState } from "react";

import { Button, Input } from "@/components/ui";
import { downloadRunBatchExport } from "@/lib/download-run-batch-export";
import {
  buildRunBatchExportQuery,
  DEFAULT_EXPORT_OUTCOMES,
  EXPORT_OUTCOME_OPTIONS,
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
  const [template, setTemplate] = useState<RunBatchExportTemplate>("results");
  const [selectedOutcomes, setSelectedOutcomes] = useState<ReadonlySet<ExportOutcomeFilter>>(
    () => new Set(DEFAULT_EXPORT_OUTCOMES),
  );
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

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

  const hasSelection = template === "failure-analysis" || selectedOutcomes.size > 0;

  async function exportResults(): Promise<void> {
    if (!hasSelection || exporting) return;
    setExporting(true);
    setError("");
    try {
      const query = buildRunBatchExportQuery(scope, round, [...selectedOutcomes], template);
      await downloadRunBatchExport(batchId, query);
      onClose();
    } catch (exportFailure) {
      setError(exportFailure instanceof Error ? exportFailure.message : "导出执行结果失败。");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog
      open
      title={"导出执行结果"}
      onClose={onClose}
      className={cn(
        "runner-update-dialog export-dialog",
        runBatchExportDialogStyles["runner-update-dialog"],
        runBatchExportDialogStyles["export-dialog"],
      )}
      backdropClassName="runner-update-overlay"
    >
      <header
        className={cn(
          "runner-update-titlebar",
          runBatchExportDialogStyles["runner-update-titlebar"],
        )}
      >
        <span>
          <Download size={16} aria-hidden="true" />
          <strong>导出执行结果</strong>
          <small>Excel（.xlsx）</small>
        </span>
        <Button aria-label="关闭" onClick={onClose} type="button">
          <X size={16} />
        </Button>
      </header>
      <div className={cn("runner-update-body", runBatchExportDialogStyles["runner-update-body"])}>
        <fieldset
          className={cn("export-dialog-group", runBatchExportDialogStyles["export-dialog-group"])}
        >
          <legend>导出内容</legend>
          <label
            className={cn(
              "export-dialog-option",
              runBatchExportDialogStyles["export-dialog-option"],
            )}
          >
            <Input
              checked={template === "results"}
              name="export-template"
              onChange={() => setTemplate("results")}
              type="radio"
            />
            <span>
              标准执行结果
              <small>按筛选结果导出执行时间、耗时和日志链接</small>
            </span>
          </label>
          <label
            className={cn(
              "export-dialog-option",
              runBatchExportDialogStyles["export-dialog-option"],
            )}
          >
            <Input
              checked={template === "failure-analysis"}
              name="export-template"
              onChange={() => setTemplate("failure-analysis")}
              type="radio"
            />
            <span>
              失败用例分析清单
              <small>仅包含失败或异常结束的用例，附带可填写的分析字段</small>
            </span>
          </label>
        </fieldset>
        <fieldset
          className={cn("export-dialog-group", runBatchExportDialogStyles["export-dialog-group"])}
        >
          <legend>导出范围</legend>
          {round !== undefined ? (
            <label
              className={cn(
                "export-dialog-option",
                runBatchExportDialogStyles["export-dialog-option"],
              )}
            >
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
          <label
            className={cn(
              "export-dialog-option",
              runBatchExportDialogStyles["export-dialog-option"],
            )}
          >
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
          <label
            className={cn(
              "export-dialog-option",
              runBatchExportDialogStyles["export-dialog-option"],
            )}
          >
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
        {template === "results" ? (
          <fieldset
            className={cn("export-dialog-group", runBatchExportDialogStyles["export-dialog-group"])}
          >
            <legend>结果类型</legend>
            {EXPORT_OUTCOME_OPTIONS.map((option) => (
              <label
                className={cn(
                  "export-dialog-option",
                  runBatchExportDialogStyles["export-dialog-option"],
                )}
                key={option.value}
              >
                <Input
                  checked={selectedOutcomes.has(option.value)}
                  onChange={() => toggleOutcome(option.value)}
                  type="checkbox"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className={cn("export-dialog-note", runBatchExportDialogStyles["export-dialog-note"])}>
            分析结果列可选：重跑通过、用例问题已修改、代码问题已提单。
          </p>
        )}
        {template === "results" && !hasSelection ? (
          <p
            className={cn("export-dialog-hint", runBatchExportDialogStyles["export-dialog-hint"])}
            role="status"
          >
            请至少选择一种结果类型后再导出。
          </p>
        ) : null}
        {error ? (
          <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
            {error}
          </Notice>
        ) : null}
        <div
          className={cn(
            "runner-installer-actions",
            runBatchExportDialogStyles["runner-installer-actions"],
          )}
        >
          <Button
            className={cn("button-primary", uiPatterns["button-primary"])}
            disabled={!hasSelection || exporting}
            onClick={() => void exportResults()}
            type="button"
          >
            {exporting ? (
              <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
            ) : (
              <Download size={15} />
            )}{" "}
            {exporting
              ? "正在导出..."
              : template === "failure-analysis"
                ? "导出分析清单"
                : "导出 Excel"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const runBatchExportDialogStyles = {
  "export-dialog":
    "w-[min(100%_-_48px,_500px)] [&_.runner-installer-actions]:justify-end [&_.runner-installer-actions]:border-t [&_.runner-installer-actions]:border-solid [&_.runner-installer-actions]:border-border [&_.runner-installer-actions]:pt-3.5",
  "export-dialog-group":
    "grid gap-2 m-0 border-0 p-0 [&_legend]:mb-2 [&_legend]:p-0 [&_legend]:text-muted-foreground [&_legend]:text-xs [&_legend]:font-semibold",
  "export-dialog-hint": "m-0 text-warning text-xs",
  "export-dialog-note":
    "m-0 border border-solid border-transparent rounded-lg py-2.5 px-3 bg-info/10 text-muted-foreground text-xs leading-[1.6]",
  "export-dialog-option":
    "flex items-start gap-2.5 border border-solid border-border rounded-lg py-2.5 px-3 bg-card cursor-pointer text-sm [&:has(:checked)]:[border-color:color-mix(in_srgb,_var(--info),_transparent_45%)] [&:has(:checked)]:bg-info/10 [&_.ui-input]:mt-px [&_small]:block [&_small]:mt-0.5 [&_small]:text-muted-foreground [&_small]:text-xs",
  "runner-installer-actions":
    "flex items-center gap-3.5 [&_button]:inline-flex [&_button]:items-center [&_button]:gap-[7px] [&_small]:text-muted-foreground",
  "runner-update-body": "grid gap-4 p-4.5 overflow-y-auto",
  "runner-update-dialog":
    "grid w-[min(640px,_92vw)] max-h-[86vh] [grid-template-rows:auto_minmax(0,_1fr)] overflow-hidden border border-solid border-border rounded-xl bg-card shadow-lg",

  "runner-update-titlebar":
    "flex items-center justify-between gap-3 py-3.5 px-4.5 border-b border-solid border-border [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-2.5 [&_small]:text-muted-foreground",
} as const;
