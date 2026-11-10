"use client";

import { Checkbox, Radio } from "antd";
import type { ExportOutcomeFilter, RunBatchExportTemplate } from "@autoforge/contracts";
import { Download } from "lucide-react";
import { useState } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui";
import { Notice } from "@/components/ui/notice";
import { useRunBatchExport } from "./use-run-batch-export";
import { ExportDataIssuesDialog } from "./export-data-issues-dialog";
import {
  buildRunBatchExportQuery,
  DEFAULT_EXPORT_OUTCOMES,
  EXPORT_OUTCOME_OPTIONS,
  type RunBatchExportScope,
  type RunBatchExportAccess,
} from "@/lib/run-batch-export";
import { cn } from "@/lib/utils";
import { downloadFailureLogsExport } from "@/lib/download-run-batch-export";

/** Keeps export choices local; the shared dialog owns sizing, scrolling and focus. */
export function RunBatchExportDialog({
  batchId,
  round,
  roundLabelText,
  defaultScope,
  onClose,
  access,
}: {
  batchId: string;
  /** Aggregate views omit the current-round choice. */
  round?: number | undefined;
  roundLabelText?: string | undefined;
  defaultScope?: RunBatchExportScope;
  onClose: () => void;
  access?: RunBatchExportAccess;
}) {
  const publicExport = !!(access?.accessToken || access?.publicAccess);
  const [scope, setScope] = useState<RunBatchExportScope>(
    defaultScope ?? (round === undefined ? "all" : "round"),
  );
  const [template, setTemplate] = useState<RunBatchExportTemplate>("results");
  const [selectedOutcomes, setSelectedOutcomes] = useState<ExportOutcomeFilter[]>(() => [
    ...DEFAULT_EXPORT_OUTCOMES,
  ]);
  const {
    exporting: exportingWorkbook,
    error,
    report,
    exportFile,
    excludeInvalidRows,
    dismissReport,
  } = useRunBatchExport({ batchId, onDownloaded: onClose, ...(access ? { access } : {}) });
  const failureLogs = useRunBatchExport({
    batchId,
    onDownloaded: onClose,
    downloadFile: downloadFailureLogsExport,
    failureMessage: "导出失败日志失败。",
  });
  const exporting = exportingWorkbook || failureLogs.exporting;
  const hasSelection = template === "failure-analysis" || selectedOutcomes.length > 0;
  const exportLabel = exporting
    ? "正在导出…"
    : template === "failure-analysis"
      ? "导出分析清单"
      : "导出 Excel";

  async function exportResults(): Promise<void> {
    if (!hasSelection || exporting) return;
    const query = buildRunBatchExportQuery(scope, round, selectedOutcomes, template);
    await exportFile(query);
  }

  return (
    <>
      <ActionDialog
        open
        inactive={report !== null}
        title="导出执行结果"
        description={
          publicExport
            ? "按所选范围导出已公开的标准执行结果。"
            : "选择导出范围，可分别下载 Excel 或失败日志 ZIP。"
        }
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
          {!publicExport ? (
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
          ) : null}
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
                <Notice tone="warning" className="m-0 mt-2 text-xs text-warning" role="status">
                  请至少选择一种结果类型后再导出。
                </Notice>
              ) : null}
            </fieldset>
          ) : (
            <Notice tone="info">分析结果列可选：重跑通过、用例问题已修改、代码问题已提单。</Notice>
          )}
          {!publicExport ? (
            <section
              aria-label="失败日志导出"
              className="grid min-w-0 gap-3 rounded-lg border border-border bg-muted/40 p-3"
            >
              <div>
                <h3 className="m-0 text-sm font-semibold">失败日志</h3>
                <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
                  独立下载 ZIP，范围沿用上方选择，仅包含失败或异常结束的执行记录。每例一个完整 .log
                  文件，按类路径／CaseID 命名，清理颜色控制字符；不修改 Excel 内容。
                </p>
              </div>
              <div>
                <Button
                  type="button"
                  disabled={exporting}
                  loading={failureLogs.exporting}
                  aria-label="导出失败日志 ZIP"
                  onClick={() => {
                    const parameters = new URLSearchParams({ scope });
                    if (scope === "round" && round !== undefined)
                      parameters.set("round", String(round));
                    void failureLogs.exportFile(parameters.toString());
                  }}
                >
                  <Download size={15} aria-hidden="true" />
                  导出失败日志 ZIP
                </Button>
              </div>
            </section>
          ) : null}
          {failureLogs.error ? (
            <Notice tone="error" role="alert">
              {failureLogs.error}
            </Notice>
          ) : null}
          {error ? (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          ) : null}
        </div>
      </ActionDialog>
      {report ? (
        <ExportDataIssuesDialog
          report={report}
          exporting={exporting}
          error={error}
          onExclude={() => void excludeInvalidRows()}
          onClose={dismissReport}
        />
      ) : null}
    </>
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
