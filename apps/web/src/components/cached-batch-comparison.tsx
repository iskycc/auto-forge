"use client";

import {
  batchComparisonPartSchema,
  type AnalyticsBatchComparison,
  type ReadModelStatus,
} from "@autoforge/contracts";
import { useEffect, useState } from "react";
import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";
import { BatchComparisonDetails } from "./batch-comparison-details";
import { Button } from "./ui";

export function CachedBatchComparison({
  snapshot,
  partCount,
}: {
  snapshot: ReadModelStatus;
  partCount: number;
}) {
  const [cases, setCases] = useState<AnalyticsBatchComparison["cases"] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const epoch = browserCacheEpoch();
    async function load() {
      const collected: AnalyticsBatchComparison["cases"] = [];
      setError("");
      try {
        for (let ordinal = 0; ordinal < partCount; ordinal += 4) {
          const parts = await Promise.all(
            Array.from({ length: Math.min(4, partCount - ordinal) }, async (_, index) => {
              const key = `comparison:${snapshot.id}:${snapshot.generation}:${ordinal + index}`;
              const cached = readBrowserSnapshot(key);
              if (cached !== undefined) return batchComparisonPartSchema.parse(cached);
              const response = await fetch(
                `/api/v1/read-models/${snapshot.id}/parts?generation=${snapshot.generation}&ordinal=${ordinal + index}`,
                { signal: controller.signal },
              );
              if (!response.ok) throw new Error("读取对比明细失败，请刷新数据后重试。");
              const part = batchComparisonPartSchema.parse(await response.json());
              writeBrowserSnapshot(key, part, epoch);
              return part;
            }),
          );
          for (const part of parts) collected.push(...part);
        }
        if (!controller.signal.aborted) setCases(collected);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取对比明细失败。");
      }
    }
    void load();
    return () => controller.abort();
  }, [snapshot.id, snapshot.generation, partCount, retry]);
  return (
    <>
      {error ? (
        <p role="alert">
          {error}
          <Button onClick={() => setRetry((value) => value + 1)}>重试</Button>
        </p>
      ) : null}
      {cases ? (
        <BatchComparisonDetails cases={cases} />
      ) : (
        <p aria-live="polite">正在载入对比明细…</p>
      )}
    </>
  );
}
