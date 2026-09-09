import {
  browserCacheEpoch,
  clearBrowserSnapshots,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "./browser-read-cache";
import { readApiError } from "./client-api";

export async function requestDdtJson<Result>(url: string, init?: RequestInit): Promise<Result> {
  const read = !init?.method || init.method === "GET";
  if (read && init?.cache !== "reload") {
    const cached = readBrowserSnapshot(url);
    if (cached !== undefined) return cached as Result;
  }
  if (!read) clearBrowserSnapshots();
  const epoch = browserCacheEpoch();
  const response = await fetch(url, init);
  const error = await readApiError(response, "无法读取或保存 DDT 关联，请重试。");
  if (error) throw error;
  const result = (await response.json()) as Result;
  if (read) writeBrowserSnapshot(url, result, epoch);
  return result;
}
