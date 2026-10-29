"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { DirectoryBranch, ReadModelStatus } from "@autoforge/contracts";
import {
  isDirectoryProjectionUsable,
  readDirectoryProjection,
  type DirectoryProjection,
  type DirectoryReadPolicy,
} from "@/lib/directory-projection";
import { readLazyDirectoryBranch, type DirectorySource } from "@/lib/directory-tree";
import { requestReadModelRefresh } from "@/lib/read-model-refresh";

const DIRECTORY_SEARCH_DELAY_MS = 300;

export function useDirectoryTree(
  snapshot: ReadModelStatus,
  filters: string,
  { minimumRevision, allowPublishedFallback = false }: DirectoryReadPolicy = {},
  visibilityRef?: RefObject<HTMLElement | null>,
) {
  const [projection, setProjection] = useState<DirectoryProjection>();
  const [responseState, setResponseState] = useState<{ requestKey: string; error: string }>();
  const [attempt, setAttempt] = useState(0);
  const [retryingKey, setRetryingKey] = useState<string>();
  const retryController = useRef<AbortController | null>(null);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const requestKey = JSON.stringify([
    snapshot.id,
    snapshot.generation,
    filters,
    minimumRevision,
    allowPublishedFallback,
    attempt,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let reading = false;
    async function read() {
      clearTimeout(timer);
      if (reading || controller.signal.aborted) return;
      if (
        document.visibilityState !== "visible" ||
        visibilityRef?.current?.getClientRects().length === 0
      ) {
        timer = setTimeout(() => void read(), 1000);
        return;
      }
      reading = true;
      try {
        const next = await readDirectoryProjection(snapshot.id, filters, controller.signal);
        if (controller.signal.aborted) return;
        const usable = isDirectoryProjectionUsable(next, {
          allowPublishedFallback,
          ...(minimumRevision === undefined ? {} : { minimumRevision }),
        });
        if (usable) {
          setProjection((current) =>
            current?.status.id === next.status.id &&
            current.status.generation === next.status.generation &&
            current.status.state === next.status.state &&
            current.synchronized === next.synchronized
              ? current
              : next,
          );
          setResponseState((current) =>
            current?.requestKey === requestKey && !current.error
              ? current
              : { requestKey, error: "" },
          );
        }
        // A published fallback is usable for browsing, but is not the end of the refresh.
        if (!usable || next.synchronized === false) {
          if (next.status.state === "failed") throw new Error("后台准备目录失败，请重试。");
          if (++polls >= 120) throw new Error("后台仍在准备目录，请稍后重试。");
          timer = setTimeout(() => void read(), 1000);
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setResponseState({
          requestKey,
          error:
            cause instanceof Error && cause.name === "TimeoutError"
              ? "目录读取超时，请稍后重试。"
              : cause instanceof Error
                ? cause.message
                : "目录加载失败。",
        });
      } finally {
        reading = false;
      }
    }
    // Debounce I/O only: a delayed history write can cancel an in-flight Next link navigation.
    if (new URLSearchParams(filters).get("query")) {
      timer = setTimeout(() => void read(), DIRECTORY_SEARCH_DELAY_MS);
    } else {
      void read();
    }
    document.addEventListener("visibilitychange", read);
    return () => {
      controller.abort();
      retryController.current?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [
    snapshot.id,
    snapshot.generation,
    filters,
    minimumRevision,
    allowPublishedFallback,
    attempt,
    requestKey,
    visibilityRef,
  ]);
  async function retry() {
    if (retryController.current && !retryController.current.signal.aborted) return;
    const controller = new AbortController();
    retryController.current = controller;
    setRetryingKey(requestKey);
    try {
      await requestReadModelRefresh(
        [projection?.status.id ?? snapshot.id],
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      if (!controller.signal.aborted) refresh();
    } catch (cause) {
      if (!controller.signal.aborted)
        setResponseState({
          requestKey,
          error:
            cause instanceof Error && cause.name === "TimeoutError"
              ? "目录重新生成请求超时，请稍后重试。"
              : cause instanceof Error
                ? cause.message
                : "目录重新生成请求失败，请重试。",
        });
    } finally {
      if (retryController.current === controller) {
        retryController.current = null;
        setRetryingKey(undefined);
      }
    }
  }
  const loading = responseState?.requestKey !== requestKey;
  return {
    projection,
    error: loading ? "" : responseState.error,
    loading,
    refreshing: projection?.synchronized === false,
    refresh,
    retry,
    retrying: retryingKey === requestKey,
  };
}

export function useDirectoryBranch(
  source: DirectorySource | undefined,
  ordinal: number | undefined,
  active: boolean,
) {
  const [chunks, setChunks] = useState<Array<{ ordinal: number; branch: DirectoryBranch }>>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [requestedOrdinal, setRequestedOrdinal] = useState(ordinal);
  const [attempt, setAttempt] = useState(0);
  const projection = source?.projection;
  const refresh = source?.refresh;
  const snapshotId = projection?.status.id;
  const generation = projection?.status.generation;
  const scope = `${snapshotId}:${generation}:${ordinal}`;
  const [previousScope, setPreviousScope] = useState(scope);
  if (previousScope !== scope) {
    setPreviousScope(scope);
    setChunks([]);
    setRequestedOrdinal(ordinal);
    setError("");
  }
  const branches = chunks.map((chunk) => chunk.branch);
  useEffect(() => {
    if (!active || !snapshotId || !generation || requestedOrdinal === undefined) return;
    const controller = new AbortController();
    async function read() {
      setLoading(true);
      setError("");
      try {
        const branch = await readLazyDirectoryBranch({
          projection: { status: { id: snapshotId!, generation: generation! } },
          ordinal: requestedOrdinal!,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setChunks((current) => {
          const retained = current.filter((chunk) => chunk.ordinal !== requestedOrdinal);
          return [...retained, { ordinal: requestedOrdinal!, branch }].sort(
            (a, b) => a.ordinal - b.ordinal,
          );
        });
        setLoading(false);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof Error && cause.name === "DirectoryGenerationConflict") refresh?.();
        setError(cause instanceof Error ? cause.message : "目录加载失败。");
        setLoading(false);
      }
    }
    void read();
    return () => controller.abort();
    // Status polling may return a new object for the same immutable generation. It must not abort
    // an in-flight branch read and start it again before its browser cache can be populated.
  }, [active, snapshotId, generation, ordinal, requestedOrdinal, refresh, attempt]);
  const nextOrdinal = branches.at(-1)?.nextOrdinal;
  return {
    branches,
    error,
    loading,
    more: nextOrdinal !== undefined && nextOrdinal !== null,
    loadMore: () => {
      if (nextOrdinal !== undefined && nextOrdinal !== null) setRequestedOrdinal(nextOrdinal);
    },
    retry: () => setAttempt((value) => value + 1),
  };
}
