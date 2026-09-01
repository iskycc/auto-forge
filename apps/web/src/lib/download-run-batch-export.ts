import { readApiErrorMessage } from "@/lib/client-api";
import { parseExportFilename } from "@/lib/run-batch-export";

/** Browser-only download primitive shared by the execution export dialog and analysis pages. */
export async function downloadRunBatchExport(
  batchId: string,
  query: string,
  failureMessage = "导出执行结果失败。",
): Promise<void> {
  const response = await fetch(
    `/api/v1/run-batches/${encodeURIComponent(batchId)}/export?${query}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error((await readApiErrorMessage(response, failureMessage))!);
  }
  const objectUrl = URL.createObjectURL(await response.blob());
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
