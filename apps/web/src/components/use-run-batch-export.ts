"use client";

import { exportValidationReportSchema, type ExportValidationReport } from "@autoforge/contracts";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "@/lib/client-api";
import { downloadRunBatchExport } from "@/lib/download-run-batch-export";

export function useRunBatchExport({
  batchId,
  failureMessage = "导出执行结果失败。",
  onDownloaded,
}: {
  batchId: string;
  failureMessage?: string;
  onDownloaded?: () => void;
}) {
  const [state, setState] = useState({
    batchId,
    exporting: false,
    error: "",
    report: null as ExportValidationReport | null,
  });
  const activeDownload = useRef<{ batchId: string; controller: AbortController } | null>(null);
  const requestedQuery = useRef({ batchId, query: "" });
  useEffect(
    () => () => {
      if (activeDownload.current?.batchId === batchId) {
        activeDownload.current.controller.abort();
        activeDownload.current = null;
      }
    },
    [batchId],
  );

  async function exportFile(query: string): Promise<void> {
    if (activeDownload.current) return;
    const controller = new AbortController();
    const download = { batchId, controller };
    activeDownload.current = download;
    requestedQuery.current = { batchId, query };
    setState((current) => ({
      batchId,
      exporting: true,
      error: "",
      report: current.batchId === batchId ? current.report : null,
    }));
    try {
      await downloadRunBatchExport(batchId, query, failureMessage, controller.signal);
      if (controller.signal.aborted || activeDownload.current !== download) return;
      setState({ batchId, exporting: false, error: "", report: null });
      onDownloaded?.();
    } catch (cause) {
      if (controller.signal.aborted || activeDownload.current !== download) return;
      const parsed =
        cause instanceof ApiClientError && cause.code === "EXPORT_DATA_INVALID"
          ? exportValidationReportSchema.safeParse(cause.details)
          : undefined;
      if (parsed?.success && parsed.data.excludedRows > 0)
        setState({ batchId, exporting: false, error: "", report: parsed.data });
      else
        setState((current) => ({
          ...current,
          error: cause instanceof Error ? cause.message : failureMessage,
        }));
    } finally {
      if (activeDownload.current === download) {
        activeDownload.current = null;
        setState((current) =>
          current.batchId === batchId ? { ...current, exporting: false } : current,
        );
      }
    }
  }

  function excludeInvalidRows(): Promise<void> {
    if (requestedQuery.current.batchId !== batchId) return Promise.resolve();
    const parameters = new URLSearchParams(requestedQuery.current.query);
    parameters.set("invalidRows", "exclude");
    return exportFile(parameters.toString());
  }

  function dismissReport(): void {
    if (!activeDownload.current) setState({ batchId, exporting: false, error: "", report: null });
  }

  const current = state.batchId === batchId ? state : { exporting: false, error: "", report: null };
  return { ...current, exportFile, excludeInvalidRows, dismissReport };
}
