import { readApiErrorMessage } from "./client-api";
import { parseExportFilename } from "./run-batch-export";
import { activePlatformTimeZone } from "./platform-date-time";

export async function downloadExecutionExceptions(
  batchId: string,
  accessToken: string | undefined,
  signal: AbortSignal,
  publicAccess = false,
): Promise<void> {
  const query = new URLSearchParams({
    time_zone: activePlatformTimeZone(),
  });
  if (accessToken) query.set("access_token", accessToken);
  if (publicAccess) query.set("public", "1");
  const response = await fetch(
    `/api/v1/run-batches/${encodeURIComponent(batchId)}/exceptions/export?${query}`,
    { cache: "no-store", signal },
  );
  if (!response.ok)
    throw new Error(await readApiErrorMessage(response, "导出异常原因失败，请重试。"));
  let content: Blob;
  try {
    content = await response.blob();
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new Error("Excel 下载中断，请重试。", { cause });
  }
  signal.throwIfAborted();
  const objectUrl = URL.createObjectURL(content);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = parseExportFilename(
      response.headers.get("content-disposition"),
      "execution-exceptions.xlsx",
    );
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
