import { throwApiErrorResponse } from "@/lib/client-api";
import { parseExportFilename } from "@/lib/run-batch-export";

/** Browser-only download primitive shared by the execution export dialog and analysis pages. */
export async function downloadRunBatchExport(
  batchId: string,
  query: string,
  failureMessage = "导出执行结果失败。",
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/v1/run-batches/${encodeURIComponent(batchId)}/export?${query}`,
    { cache: "no-store", ...(signal ? { signal } : {}) },
  );
  if (!response.ok) {
    await throwApiErrorResponse(response, failureMessage);
  }
  const blob = await response.blob();
  signal?.throwIfAborted();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = parseExportFilename(response.headers.get("content-disposition"));
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
