import { useCallback, useEffect, useState } from "react";

export type CursorPage<T> = { items: T[]; hasMore: boolean; nextCursor?: string };

export function usePage<T>(path: string | null) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: "" });
  const key = JSON.stringify([path, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    async function read() {
      try {
        const response = await fetch(path!, { signal, cache: "no-store" });
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const message =
            body &&
            typeof body === "object" &&
            "message" in body &&
            typeof body.message === "string"
              ? body.message
              : "离线归档读取失败，请重试。";
          throw new Error(message);
        }
        const data = (await response.json()) as T;
        if (!controller.signal.aborted) setState({ key, data });
      } catch (cause) {
        if (!controller.signal.aborted)
          setState({
            key,
            error:
              cause instanceof Error && cause.name === "TimeoutError"
                ? "读取归档超时，请重试。"
                : cause instanceof Error
                  ? cause.message
                  : "读取归档失败。",
          });
      }
    }
    void read();
    return () => controller.abort();
  }, [path, key]);
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    loading: path !== null && state.key !== key,
    retry,
  };
}
