"use client";

import { Checkbox, Radio } from "antd";
import type { ExportOutcomeFilter, RunBatchExportTemplate } from "@autoforge/contracts";
import { Download } from "lucide-react";
import { useState } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui";
import { Notice } from "@/components/ui/notice";
import { downloadRunBatchExport } from "@/lib/download-run-batch-export";
import {
  buildRunBatchExportQuery,
  DEFAULT_EXPORT_OUTCOMES,
  EXPORT_OUTCOME_OPTIONS,
  type RunBatchExportScope,
} from "@/lib/run-batch-export";
import { cn } from "@/lib/utils";

/** Keeps export choices local; the shared dialog owns sizing, scrolling and focus. */
export function RunBatchExportDialog({
  batchId,
  round,
  roundLabelText,
  defaultScope,
  onClose,
}: {
  batchId: string;
  /** Aggregate views omit the current-round choice. */
  round?: number | undefined;
  roundLabelText?: string | undefined;
  defaultScope?: RunBatchExportScope;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<RunBatchExportScope>(
    defaultScope ?? (round === undefined ? "all" : "round"),
  );
  const [template, setTemplate] = useState<RunBatchExportTemplate>("results");
  const [selectedOutcomes, setSelectedOutcomes] = useState<ExportOutcomeFilter[]>(() => [
    ...DEFAULT_EXPORT_OUTCOMES,
  ]);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const hasSelection = template === "failure-analysis" || selectedOutcomes.length > 0;
  const exportLabel = exporting
    ? "正在导出…"
    : template === "failure-analysis"
      ? "导出分析清单"
      : "导出 Excel";

  async function exportResults(): Promise<void> {
    if (!hasSelection || exporting) return;
    setExporting(true);
    setError("");
    try {
      const query = buildRunBatchExportQuery(scope, round, selectedOutcomes, template);
      await downloadRunBatchExport(batchId, query);
      onClose();
    } catch (exportFailure) {
      setError(exportFailure instanceof Error ? exportFailure.message : "导出执行结果失败。");
    } finally {
      setExporting(false);
    }
  }

  return (
    <ActionDialog
      open
      title="导出执行结果"
      description="选择导出内容与范围，下载 Excel（.xlsx）文件。"
      onClose={onClose}
      closeDisabled={exporting}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button disabled={exporting} onClick={onClose} type="button">
            取消
          </Button>
          <Button
            aria-label={exportLabel}
            variant="primary"
            disabled={!hasSelection || exporting}
            loading={exporting}
            onClick={() => void exportResults()}
            type="button"
          >
            {!exporting ? <Download size={15} aria-hidden="true" /> : null}
            {exportLabel}
          </Button>
        </div>
      }
    >
      <div className="grid min-w-0 gap-4">
        <fieldset className={groupClassName}>
          <legend>导出内容</legend>
          <Radio.Group
            name="export-template"
            value={template}
            onChange={(event) => setTemplate(event.target.value as RunBatchExportTemplate)}
            disabled={exporting}
            className="w-full grid-cols-2 gap-3"
            style={{ display: "grid" }}
          >
            <ExportChoice
              value="results"
              selected={template === "results"}
              label="标准执行结果"
              description="按筛选结果导出执行时间、耗时和日志链接"
            />
            <ExportChoice
              value="failure-analysis"
              selected={template === "failure-analysis"}
              label="失败用例分析清单"
              description="仅包含失败或异常结束的用例，附带可填写的分析字段"
            />
          </Radio.Group>
        </fieldset>
        <fieldset className={groupClassName}>
          <legend>导出范围</legend>
          <Radio.Group
            name="export-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as RunBatchExportScope)}
            disabled={exporting}
            className="w-full gap-2"
            style={{ display: "grid" }}
          >
            {round !== undefined ? (
              <ExportChoice
                value="round"
                selected={scope === "round"}
                label="当前轮次"
                description={
                  roundLabelText ? `${roundLabelText}（第 ${round} 轮）` : `第 ${round} 轮`
                }
              />
            ) : null}
            <ExportChoice
              value="all"
              selected={scope === "all"}
              label="全部轮次"
              description="逐条记录，标注轮次；同一用例多条记录会分行导出"
            />
            <ExportChoice
              value="final"
              selected={scope === "final"}
              label="最终结果"
              description="每个用例最终结果"
            />
          </Radio.Group>
        </fieldset>
        {template === "results" ? (
          <fieldset className={groupClassName}>
            <legend>结果类型</legend>
            <Checkbox.Group<ExportOutcomeFilter>
              value={selectedOutcomes}
              onChange={setSelectedOutcomes}
              disabled={exporting}
              className="w-full grid-cols-3 gap-x-3 gap-y-2"
              style={{ display: "grid" }}
              options={EXPORT_OUTCOME_OPTIONS.map((option) => ({ ...option }))}
            />
            {!hasSelection ? (
              <p className="m-0 mt-2 text-xs text-warning" role="status">
                请至少选择一种结果类型后再导出。
              </p>
            ) : null}
          </fieldset>
        ) : (
          <Notice tone="info">分析结果列可选：重跑通过、用例问题已修改、代码问题已提单。</Notice>
        )}
        {error ? (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        ) : null}
      </div>
    </ActionDialog>
  );
}

function ExportChoice({
  value,
  selected,
  label,
  description,
}: {
  value: RunBatchExportScope | RunBatchExportTemplate;
  selected: boolean;
  label: string;
  description: string;
}) {
  return (
    <Radio
      value={value}
      className={cn(
        "min-w-0 rounded-lg border border-solid px-3 py-2.5 transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/50",
      )}
      styles={{ root: { display: "flex", alignItems: "flex-start", margin: 0 } }}
      classNames={{ icon: "mt-1", label: "min-w-0 flex-1" }}
    >
      <span className="block text-sm font-medium">{label}</span>
      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{description}</span>
    </Radio>
  );
}

const groupClassName =
  "m-0 min-w-0 border-0 p-0 [&_legend]:mb-2 [&_legend]:p-0 [&_legend]:text-sm [&_legend]:font-semibold";
