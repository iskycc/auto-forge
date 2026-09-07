"use client";

import { useCallback, useEffect, useState } from "react";
import type { DirectoryBranch, ReadModelStatus } from "@autoforge/contracts";
import { readDirectoryProjection, type DirectoryProjection } from "@/lib/directory-projection";
import { readLazyDirectoryBranch, type DirectorySource } from "@/lib/directory-tree";

const DIRECTORY_SEARCH_DELAY_MS = 300;

export function useDirectoryTree(
  snapshot: ReadModelStatus,
  filters: string,
  minimumRevision?: number,
) {
  const [projection, setProjection] = useState<DirectoryProjection>();
  const [responseState, setResponseState] = useState<{ requestKey: string; error: string }>();
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const requestKey = JSON.stringify([
    snapshot.id,
    snapshot.generation,
    filters,
    minimumRevision,
    attempt,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    async function read() {
      try {
        const next = await readDirectoryProjection(snapshot.id, filters, controller.signal);
        const revision = (next.manifest as { revision?: number } | null)?.revision;
        if (controller.signal.aborted) return;
        if (next.status.state === "failed") throw new Error("后台准备目录失败，请重试。");
        if (
          next.manifest?.rootOrdinal === undefined ||
          !next.status.generation ||
          next.synchronized === false ||
          (minimumRevision !== undefined && (revision === undefined || revision < minimumRevision))
        ) {
          if (++polls >= 120) throw new Error("后台仍在准备目录，请稍后重试。");
          timer = setTimeout(() => void read(), 1000);
          return;
        }
        setProjection(next);
        setResponseState({ requestKey, error: "" });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setResponseState({
          requestKey,
          error: cause instanceof Error ? cause.message : "目录加载失败。",
        });
      }
    }
    // Debounce I/O only: a delayed history write can cancel an in-flight Next link navigation.
    if (new URLSearchParams(filters).get("query")) {
      timer = setTimeout(() => void read(), DIRECTORY_SEARCH_DELAY_MS);
    } else {
      void read();
    }
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [snapshot.id, snapshot.generation, filters, minimumRevision, attempt, requestKey]);
  const loading = responseState?.requestKey !== requestKey;
  return { projection, error: loading ? "" : responseState.error, loading, refresh };
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
