"use client";

import {
  suiteDirectoryPartSchema,
  type SuiteDirectoryManifest,
  type SuiteDirectoryPart,
  type ReadModelStatus,
} from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";
import { CaseSuiteDetailsView } from "./case-suite-details";
import { ReadModelStatusBar } from "./read-model-status";
import { Button } from "./ui";

export function CachedSuiteDirectory({
  suite,
  snapshot,
  manifest,
  canManage,
}: {
  suite: CaseSuite;
  snapshot: ReadModelStatus;
  manifest: SuiteDirectoryManifest | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [members, setMembers] = useState<CaseSuite & SuiteDirectoryPart>();
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const partCount = manifest?.partCount ?? 0;
  const revision = manifest?.revision;
  useEffect(() => {
    if (!snapshot.generation || revision !== suite.revision) return;
    const controller = new AbortController();
    const epoch = browserCacheEpoch();
    async function load() {
      const result: SuiteDirectoryPart = { items: [], ddtItems: [] };
      setError("");
      setLoaded(0);
      try {
        for (let ordinal = 0; ordinal < partCount; ordinal += 4) {
          const parts = await Promise.all(
            Array.from({ length: Math.min(4, partCount - ordinal) }, async (_, offset) => {
              const index = ordinal + offset;
              const key = `suite-directory:v1:${snapshot.id}:${snapshot.generation}:${index}`;
              const cached = readBrowserSnapshot(key);
              if (cached) return suiteDirectoryPartSchema.parse(cached);
              const response = await fetch(
                `/api/v1/read-models/${snapshot.id}/parts?generation=${snapshot.generation}&ordinal=${index}`,
                { signal: controller.signal, cache: "no-store" },
              );
              if (response.status === 409) router.refresh();
              if (!response.ok) throw new Error("任务成员正在更新，请重试。");
              const part = suiteDirectoryPartSchema.parse(await response.json());
              writeBrowserSnapshot(key, part, epoch);
              return part;
            }),
          );
          if (controller.signal.aborted) return;
          for (const part of parts) {
            result.items.push(...part.items);
            result.ddtItems.push(...part.ddtItems);
          }
          setLoaded(result.items.length + result.ddtItems.length);
        }
        if (!controller.signal.aborted) setMembers({ ...suite, ...result });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取任务成员失败。");
      }
    }
    void load();
    return () => controller.abort();
  }, [snapshot.id, snapshot.generation, partCount, revision, suite, retry, router]);
  return (
    <>
      <ReadModelStatusBar snapshots={[snapshot]} />
      {error ? (
        <div role="alert" className="inline-feedback error">
          {error}
          <Button onClick={() => setRetry((value) => value + 1)}>重试</Button>
        </div>
      ) : null}
      {!members ? (
        <section className="card">
          <p role="status">
            正在准备任务成员 {loaded.toLocaleString()} / {suite.caseCount.toLocaleString()}
            ，任务配置可直接编辑。
          </p>
        </section>
      ) : (
        <CaseSuiteDetailsView canManage={canManage} initialSuite={members} />
      )}
    </>
  );
}
