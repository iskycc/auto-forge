"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { publicSuiteViewSchema, type PublicSuiteView } from "@autoforge/contracts";
import { throwApiErrorResponse } from "@/lib/client-api";

export function usePublicSuite(initial: PublicSuiteView) {
  const [view, setView] = useState(initial);
  const [error, setError] = useState("");
  const pending = useRef<Promise<void> | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const endpoint = `/api/v1/public/case-suites/${encodeURIComponent(initial.suiteId)}?${new URLSearchParams({ PublisherId: initial.publisher.id })}`;
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const request = (async () => {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: AbortSignal.any([
            lifetime.current?.signal ?? new AbortController().signal,
            AbortSignal.timeout(15000),
          ]),
        });
        if (!response.ok) await throwApiErrorResponse(response, "任务状态刷新失败。");
        const next = publicSuiteViewSchema.parse(await response.json());
        if (!lifetime.current?.signal.aborted) {
          setView(next);
          setError("");
        }
      } catch (cause) {
        if (!lifetime.current?.signal.aborted)
          setError(cause instanceof Error ? cause.message : "刷新失败，请重试。");
      } finally {
        pending.current = null;
      }
    })();
    pending.current = request;
    return request;
  }, [endpoint]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (document.visibilityState !== "hidden") await refresh();
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    }
    const visible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    timer = setTimeout(() => void poll(), 5000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  return { view, error, refresh };
}
