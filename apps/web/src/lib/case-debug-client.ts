import { readApiError } from "./client-api";
import { runBatchPreflightResultSchema } from "@autoforge/contracts";

export async function debugRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(init?.body instanceof FormData ? 300_000 : 15_000);
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const error = await readApiError(response, "请求失败，请重试。");
    const preflight = runBatchPreflightResultSchema.safeParse(error?.details);
    if (preflight.success && preflight.data.blockers.length) {
      throw new Error(preflight.data.blockers.map((blocker) => blocker.message).join("；"), {
        cause: error,
      });
    }
    throw error ?? new Error("请求失败，请重试。");
  }
  return response.json() as Promise<T>;
}
