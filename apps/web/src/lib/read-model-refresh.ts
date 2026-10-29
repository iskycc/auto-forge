export async function requestReadModelRefresh(
  ids: readonly string[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/api/v1/read-models/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
    signal,
  });
  if (!response.ok) throw new Error("请求更新失败，请稍后重试。");
}
