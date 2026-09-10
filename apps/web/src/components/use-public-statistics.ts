"use client";

import {
  publicPlatformStatisticsSchema,
  type PublicPlatformStatistics,
} from "@autoforge/contracts";
import { useEffect, useRef, useState } from "react";

const refreshTimeoutMs = 15_000;

export function usePublicStatistics(initialStatistics: PublicPlatformStatistics) {
  const [statistics, setStatistics] = useState(initialStatistics);
  const [synchronizing, setSynchronizing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeRequest: AbortController | undefined;

    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && document.visibilityState === "visible") {
        timer = setTimeout(() => void synchronize(), statistics.refreshSeconds * 1_000);
      }
    };

    const synchronize = async () => {
      if (disposed || activeRequest || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      const controller = new AbortController();
      activeRequest = controller;
      const timeout = setTimeout(() => controller.abort(), refreshTimeoutMs);
      setSynchronizing(true);
      try {
        const response = await fetch("/api/v1/public/statistics", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("公开统计同步失败。");
        const snapshot = publicPlatformStatisticsSchema.parse(await response.json());
        if (!disposed) {
          setStatistics(snapshot);
          setSyncFailed(false);
        }
      } catch {
        // The public page keeps the last snapshot and exposes a retryable status, not API internals.
        if (!disposed) setSyncFailed(true);
      } finally {
        clearTimeout(timeout);
        activeRequest = undefined;
        if (!disposed) {
          setSynchronizing(false);
          schedule();
        }
      }
    };

    const onVisibilityChange = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void synchronize();
    };

    refreshRef.current = () => void synchronize();
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      activeRequest?.abort();
      refreshRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [statistics.refreshSeconds]);

  return { statistics, synchronizing, syncFailed, refresh: () => refreshRef.current?.() };
}
