"use client";
import { Notice } from "@/components/ui/notice";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { cn } from "@/lib/utils";

import { Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui";
import { downloadRunBatchExport } from "@/lib/download-run-batch-export";
import { buildRunBatchExportQuery } from "@/lib/run-batch-export";

export function FailureAnalysisExportButton({ batchId }: { batchId: string }) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  async function exportAnalysis(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setError("");
    try {
      await downloadRunBatchExport(
        batchId,
        buildRunBatchExportQuery("final", undefined, [], "failure-analysis"),
        "导出分析结果失败。",
      );
    } catch (exportFailure) {
      setError(exportFailure instanceof Error ? exportFailure.message : "导出分析结果失败。");
    } finally {
      setExporting(false);
    }
  }

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
        onClick={() => void exportAnalysis()}
        size="compact"
        type="button"
        variant="secondary"
      >
        {exporting ? <LoadingIcon size={14} /> : <Download size={14} />}
        {exporting ? "正在导出" : "导出分析结果"}
      </Button>
      {error ? (
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
    </div>
  );
}

const failureAnalysisExportButtonStyles = {
  "failure-analysis-export-action": "relative grid justify-items-end",
  "failure-analysis-export-error":
    "absolute z-4 top-[calc(100%_+_6px)] right-0 w-max max-w-[320px] border border-solid border-border rounded-lg py-[7px] px-[9px] bg-card shadow-xs text-destructive text-xs",
} as const;
