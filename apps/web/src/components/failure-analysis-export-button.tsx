"use client";

import { Download, LoaderCircle } from "lucide-react";
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
    <div className="failure-analysis-export-action">
      <Button
        aria-label="导出分析结果"
        disabled={exporting}
        onClick={() => void exportAnalysis()}
        size="compact"
        type="button"
        variant="secondary"
      >
        {exporting ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
        {exporting ? "正在导出" : "导出分析结果"}
      </Button>
      {error ? (
        <span className="failure-analysis-export-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
