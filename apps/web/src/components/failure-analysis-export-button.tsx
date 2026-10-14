"use client";
import { Notice } from "@/components/ui/notice";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { cn } from "@/lib/utils";

import { Download } from "lucide-react";

import { Button } from "@/components/ui";
import { useRunBatchExport } from "./use-run-batch-export";
import { ExportDataIssuesDialog } from "./export-data-issues-dialog";
import { buildRunBatchExportQuery } from "@/lib/run-batch-export";

export function FailureAnalysisExportButton({ batchId }: { batchId: string }) {
  const { exporting, error, report, exportFile, excludeInvalidRows, dismissReport } =
    useRunBatchExport({ batchId, failureMessage: "导出分析结果失败。" });

  return (
    <div
      className={cn(
        "failure-analysis-export-action",
        failureAnalysisExportButtonStyles["failure-analysis-export-action"],
      )}
    >
      <Button
        aria-label="导出分析结果"
        disabled={exporting}
        onClick={() =>
          void exportFile(buildRunBatchExportQuery("final", undefined, [], "failure-analysis"))
        }
        size="compact"
        type="button"
        variant="secondary"
      >
        {exporting ? <LoadingIcon size={14} /> : <Download size={14} />}
        {exporting ? "正在导出" : "导出分析结果"}
      </Button>
      {error && !report ? (
        <Notice
          tone="error"
          className={cn(
            "failure-analysis-export-error",
            failureAnalysisExportButtonStyles["failure-analysis-export-error"],
          )}
          role="alert"
        >
          {error}
        </Notice>
      ) : null}
      {report ? (
        <ExportDataIssuesDialog
          report={report}
          exporting={exporting}
          error={error}
          onExclude={() => void excludeInvalidRows()}
          onClose={dismissReport}
        />
      ) : null}
    </div>
  );
}

const failureAnalysisExportButtonStyles = {
  "failure-analysis-export-action": "relative grid justify-items-end",
  "failure-analysis-export-error":
    "absolute z-4 top-[calc(100%_+_6px)] right-0 w-max max-w-[320px] border border-solid border-border rounded-lg py-[7px] px-[9px] bg-card shadow-xs text-destructive text-xs",
} as const;
