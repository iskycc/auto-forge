import type { RunBatchCasePage } from "@autoforge/application";
import { browserCacheEpoch, readBrowserSnapshot, writeBrowserSnapshot } from "./browser-read-cache";
import { readApiErrorMessage } from "./client-api";

/** Both case lists and attempt history reuse immutable, generation-scoped browser pages. */
export async function loadExecutionCasePage(
  url: string,
  revision: string,
  signal: AbortSignal,
): Promise<RunBatchCasePage> {
  const key = `batch-case-page:v1:${url}\u0000${revision}`;
  const cached = readBrowserSnapshot(key) as RunBatchCasePage | undefined;
  if (cached) return cached;
  const epoch = browserCacheEpoch();
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (response.status === 503 && attempt < 2) {
      const failure = (await response.clone().json()) as { error?: { code?: string } };
      if (failure.error?.code === "READ_MODEL_PENDING") {
        await response.body?.cancel();
        continue;
      }
    }
    if (!response.ok) throw new Error((await readApiErrorMessage(response, "读取执行记录失败。"))!);
    const result = (await response.json()) as RunBatchCasePage;
    if (!signal.aborted) writeBrowserSnapshot(key, result, epoch);
    return result;
  }
  throw new Error("后台正在准备执行记录，请稍后重试。");
}
