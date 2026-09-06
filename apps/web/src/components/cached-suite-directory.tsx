"use client";

import {
  suiteDirectoryManifestSchema,
  type SuiteDirectoryManifest,
  type ReadModelStatus,
} from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { CaseSuiteDetailsView } from "./case-suite-details";
import { ReadModelStatusBar } from "./read-model-status";
import { Button } from "./ui";
import { useDirectoryBranch, useDirectoryTree } from "./use-directory-tree";
import { useCaseSuiteRevision } from "./case-suite-revision";
import { updateDirectoryLocation } from "@/lib/directory-location";
import { collectDirectoryMembers } from "@/lib/directory-tree";

export function CachedSuiteDirectory({
  suite,
  snapshot,
  canManage,
}: {
  suite: CaseSuite;
  snapshot: ReadModelStatus;
  manifest: SuiteDirectoryManifest | null;
  canManage: boolean;
}) {
  const parameters = useSearchParams();
  const search = parameters.get("memberQuery") ?? "";
  const filters = new URLSearchParams({ query: search }).toString();
  const { revision } = useCaseSuiteRevision();
  const result = useDirectoryTree(snapshot, filters, revision);
  const source = useMemo(
    () =>
      result.projection ? { projection: result.projection, refresh: result.refresh } : undefined,
    [result.projection, result.refresh],
  );
  const manifest = result.projection?.manifest
    ? suiteDirectoryManifestSchema.parse(result.projection.manifest)
    : null;
  return (
    <>
      <ReadModelStatusBar snapshots={[result.projection?.status ?? snapshot]} />
      {result.error ? (
        <div role="alert" className="inline-feedback error">
          {result.error}
          <Button onClick={result.refresh}>重试</Button>
        </div>
      ) : null}
      <SuiteTree
        suite={suite}
        source={source}
        search={search}
        canManage={canManage}
        membersRevision={manifest?.revision ?? suite.revision}
        loading={result.loading}
        onQuery={(query) => updateDirectoryLocation({ memberQuery: query })}
      />
    </>
  );
}

function SuiteTree({
  suite,
  source,
  search,
  canManage,
  membersRevision,
  loading,
  onQuery,
}: {
  suite: CaseSuite;
  source: Parameters<typeof useDirectoryBranch>[0];
  search: string;
  canManage: boolean;
  membersRevision: number;
  loading: boolean;
  onQuery(query: string): void;
}) {
  const rootOrdinal = source?.projection.manifest?.rootOrdinal;
  const root = useDirectoryBranch(source, rootOrdinal, true);
  const counts = source
    ? suiteDirectoryManifestSchema.parse(source.projection.manifest)
    : undefined;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return (
    <>
      <CaseSuiteDetailsView
        canManage={canManage}
        initialSuite={{ ...suite, items: [], ddtItems: [] }}
        directoryTree={{
          source,
          ordinaryCount: counts?.ordinaryCount ?? 0,
          ddtCount: counts?.ddtCount ?? 0,
          groups: root.branches.flatMap((branch) => branch.directories),
          query: search,
          membersRevision,
          loading: loading || root.loading,
          onQuery,
          collect: async (ordinal = rootOrdinal, kind) => {
            if (!source || ordinal === undefined) throw new Error("目录尚未准备完成，请稍后重试。");
            controller.current?.abort();
            const active = new AbortController();
            controller.current = active;
            return collectDirectoryMembers(source, ordinal, active.signal, kind);
          },
        }}
      />
      {root.error ? (
        <div role="alert">
          {root.error}
          <Button onClick={root.retry}>重试</Button>
        </div>
      ) : null}
      {root.more ? (
        <Button disabled={root.loading} onClick={root.loadMore}>
          加载更多目录
        </Button>
      ) : null}
    </>
  );
}
