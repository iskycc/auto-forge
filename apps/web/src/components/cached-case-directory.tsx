"use client";
import { EmptyState } from "@/components/ui/empty-state";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import {
  caseDirectoryFilterSchema,
  type CaseDirectoryFilter,
  type CaseDirectoryManifest,
  type ReadModelStatus,
} from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { FileArchive } from "lucide-react";
import { LinkButton } from "@/components/ui/link-button";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CaseSelectionTable } from "./case-selection-table";
import { ReadModelStatusBar } from "./read-model-status";
import { Button } from "./ui";
import { useDirectoryTree } from "./use-directory-tree";
import { updateDirectoryLocation } from "@/lib/directory-location";
import { collectDirectorySelection } from "@/lib/collect-directory-selection";

export function CachedCaseDirectory({
  snapshot,
  projectId,
  manifest,
  suites,
  caseManagementProjectIds,
  suiteManagementProjectIds,
  canImport,
}: {
  snapshot: ReadModelStatus;
  projectId: string;
  manifest: CaseDirectoryManifest | null;
  suites: CaseSuite[];
  caseManagementProjectIds: string[] | undefined;
  suiteManagementProjectIds: string[] | undefined;
  canImport: boolean;
}) {
  const parameters = useSearchParams();
  const filter = caseDirectoryFilterSchema.parse({
    query: parameters.get("query") ?? "",
    outcome: parameters.get("outcome") ?? "all",
    ...(parameters.get("missingSuiteId")
      ? { missingSuiteId: parameters.get("missingSuiteId") }
      : {}),
  });
  const filters = new URLSearchParams({
    query: filter.query,
    outcome: filter.outcome,
    ...(filter.missingSuiteId ? { missingSuiteId: filter.missingSuiteId } : {}),
  }).toString();
  const result = useDirectoryTree(snapshot, filters);
  const source = useMemo(
    () =>
      result.projection ? { projection: result.projection, refresh: result.refresh } : undefined,
    [result.projection, result.refresh],
  );
  const [progress, setProgress] = useState<string>();
  const selectionController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      selectionController.current?.abort();
      selectionController.current = null;
    },
    [],
  );
  function changeFilter(next: CaseDirectoryFilter) {
    updateDirectoryLocation({
      query: next.query,
      outcome: next.outcome === "all" ? undefined : next.outcome,
      missingSuiteId: next.missingSuiteId,
    });
  }
  const currentManifest = result.projection?.manifest ?? manifest;
  return (
    <>
      <ReadModelStatusBar
        snapshots={[result.projection?.status ?? snapshot]}
        onRefresh={result.refresh}
      />
      {result.error ? (
        <div
          className={cn(
            "inline-feedback error",
            cachedCaseDirectoryStyles["inline-feedback"],
            uiPatterns["error"],
          )}
          role="alert"
        >
          {result.error}
          <Button onClick={result.refresh}>重试</Button>
        </div>
      ) : null}
      {result.loading && !result.projection ? (
        <p role="status">正在后台准备当前范围，完成后自动显示。</p>
      ) : null}
      {progress ? <p role="status">{progress}</p> : null}
      {currentManifest?.caseCount === 0 &&
      !filter.query &&
      filter.outcome === "all" &&
      !filter.missingSuiteId ? (
        <Card
          as="section"
          className={cn(
            "card case-library-empty-card",
            uiPatterns["card"],
            cachedCaseDirectoryStyles["case-library-empty-card"],
          )}
        >
          <EmptyState
            className={cn(
              "empty-state case-library-empty",
              uiPatterns["empty-state"],
              cachedCaseDirectoryStyles["case-library-empty"],
            )}
          >
            <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
              <FileArchive size={27} />
            </span>
            <strong>当前项目层级还没有用例</strong>
            <p>导入一个包含 TestNG @Test 注解的 JAR，或在顶栏调整项目版本与测试阶段。</p>
            {canImport ? (
              <LinkButton
                variant="primary"
                className={cn(
                  "button button-primary",
                  uiPatterns["button"],
                  uiPatterns["button-primary"],
                )}
                href="/cases/import"
              >
                导入第一个 JAR
              </LinkButton>
            ) : null}
          </EmptyState>
        </Card>
      ) : (
        <CaseSelectionTable
          cases={[]}
          suites={suites}
          caseManagementProjectIds={caseManagementProjectIds}
          suiteManagementProjectIds={suiteManagementProjectIds}
          initialSearch={filter.query}
          initialSuiteId={parameters.get("targetSuiteId") ?? undefined}
          directoryTree={{
            filter,
            loading: result.loading,
            ready: Boolean(result.projection),
            source,
            projectId,
            caseCount: currentManifest?.caseCount ?? 0,
            totalCount:
              filter.query || filter.outcome !== "all" || filter.missingSuiteId
                ? (manifest?.caseCount ?? 0)
                : (currentManifest?.caseCount ?? 0),
            onFilter: changeFilter,
            refresh: result.refresh,
            collect: async (paths, signal, directoryPath) => {
              selectionController.current?.abort();
              const controller = new AbortController();
              selectionController.current = controller;
              const cancel = () => controller.abort();
              if (signal?.aborted) cancel();
              signal?.addEventListener("abort", cancel, { once: true });
              setProgress("正在准备批量选择…");
              try {
                return await collectDirectorySelection({
                  baseId: snapshot.id,
                  filters: paths ? "query=&outcome=all" : filters,
                  signal: controller.signal,
                  ...(paths ? { paths } : {}),
                  ...(directoryPath !== undefined ? { directoryPath } : {}),
                  onProgress: (completed, total) =>
                    setProgress(`正在读取匹配标识 ${completed} / ${total}`),
                });
              } finally {
                signal?.removeEventListener("abort", cancel);
                if (selectionController.current === controller) setProgress(undefined);
              }
            },
          }}
        />
      )}
    </>
  );
}

const cachedCaseDirectoryStyles = {
  "case-library-empty":
    "w-[min(100%,_560px)] min-h-[320px] justify-self-center gap-1 py-10 px-6 [&_.button]:mt-4.5",
  "case-library-empty-card": "grid min-h-[360px] overflow-hidden",
  "inline-feedback":
    "border-b border-solid border-border py-2.5 px-4.5 bg-success/10 text-success text-xs [&.error]:border-destructive/10 [&.error]:bg-destructive/10 [&.error]:text-destructive",
} as const;
