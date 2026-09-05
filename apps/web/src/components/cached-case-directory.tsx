"use client";

import {
  caseDirectoryPartSchema,
  type CaseDirectoryManifest,
  type ReadModelStatus,
} from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, CaseSuite } from "@autoforge/domain";
import { FileArchive } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CaseSelectionTable } from "./case-selection-table";
import { ReadModelStatusBar } from "./read-model-status";
import { Button } from "./ui";
import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";
import type { CaseLatestRun } from "@/lib/case-selection-stats";

type Directory = { cases: CaseDefinitionWithMethods[]; outcomes: Map<string, CaseLatestRun> };

export function CachedCaseDirectory({
  snapshot,
  manifest,
  userId,
  suites,
  caseManagementProjectIds,
  suiteManagementProjectIds,
  initialSearch,
  canImport,
}: {
  snapshot: ReadModelStatus;
  manifest: CaseDirectoryManifest | null;
  userId: string;
  suites: CaseSuite[];
  caseManagementProjectIds: string[] | undefined;
  suiteManagementProjectIds: string[] | undefined;
  initialSearch: string;
  canImport: boolean;
}) {
  const router = useRouter();
  const [directory, setDirectory] = useState<Directory>({ cases: [], outcomes: new Map() });
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const partCount = manifest?.partCount ?? 0;
  useEffect(() => {
    if (!snapshot.generation) return;
    const controller = new AbortController();
    const epoch = browserCacheEpoch();
    async function load() {
      const cases: CaseDefinitionWithMethods[] = [];
      const outcomes = new Map<string, CaseLatestRun>();
      setError("");
      setLoaded(0);
      try {
        // Bounded parallel downloads; the page never embeds a complete 100k-case directory in HTML.
        for (let ordinal = 0; ordinal < partCount; ordinal += 4) {
          const parts = await Promise.all(
            Array.from({ length: Math.min(4, partCount - ordinal) }, async (_, offset) => {
              const index = ordinal + offset;
              const key = `${userId}:${snapshot.id}:${snapshot.generation}:${index}`;
              const cached = readBrowserSnapshot(key);
              if (cached !== undefined) return caseDirectoryPartSchema.parse(cached);
              const response = await fetch(
                `/api/v1/read-models/${snapshot.id}/parts?generation=${snapshot.generation}&ordinal=${index}`,
                { cache: "no-store", signal: controller.signal },
              );
              if (response.status === 409) {
                router.refresh();
                throw new Error("目录正在更新，请稍后重试。");
              }
              if (!response.ok) throw new Error("读取用例目录失败，请重试。");
              const part = caseDirectoryPartSchema.parse(await response.json());
              writeBrowserSnapshot(key, part, epoch);
              return part;
            }),
          );
          if (controller.signal.aborted) return;
          for (const part of parts) {
            cases.push(...(part.items as CaseDefinitionWithMethods[]));
            for (const outcome of part.outcomes)
              outcomes.set(outcome.caseDefinitionId, {
                outcome: outcome.outcome,
                ...(outcome.resultCode ? { resultCode: outcome.resultCode } : {}),
              });
          }
          setLoaded(cases.length);
          if (ordinal === 0)
            setDirectory((current) =>
              current.cases.length ? current : { cases: [...cases], outcomes: new Map(outcomes) },
            );
        }
        if (!controller.signal.aborted) setDirectory({ cases, outcomes });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取用例目录失败。");
      }
    }
    void load();
    return () => controller.abort();
  }, [snapshot.id, snapshot.generation, userId, partCount, retry, router]);

  return (
    <>
      <ReadModelStatusBar snapshots={[snapshot]} />
      {error ? (
        <div className="inline-feedback error" role="alert">
          {error}
          <Button onClick={() => setRetry((value) => value + 1)}>重试</Button>
        </div>
      ) : null}
      {manifest && loaded < manifest.caseCount ? (
        <p aria-live="polite">
          正在载入用例目录 {loaded.toLocaleString()} / {manifest.caseCount.toLocaleString()}
          ，已载入部分可先查看。
        </p>
      ) : null}
      {directory.cases.length ? (
        <CaseSelectionTable
          cases={directory.cases}
          suites={suites}
          latestOutcomes={directory.outcomes}
          caseManagementProjectIds={caseManagementProjectIds}
          suiteManagementProjectIds={suiteManagementProjectIds}
          initialSearch={initialSearch}
        />
      ) : manifest?.caseCount === 0 ? (
        <section className="card case-library-empty-card">
          <div className="empty-state case-library-empty">
            <span className="empty-icon">
              <FileArchive size={27} />
            </span>
            <strong>当前项目层级还没有用例</strong>
            <p>导入一个包含 TestNG @Test 注解的 JAR，或在顶栏调整项目版本与测试阶段。</p>
            {canImport ? (
              <Link className="button button-primary" href="/cases/import">
                导入第一个 JAR
              </Link>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
