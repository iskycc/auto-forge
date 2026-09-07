"use client";

import { Button, Input, OperationProgress, Select } from "@/components/ui";
import { useDirectoryBranch } from "./use-directory-tree";
import type { DirectorySource } from "@/lib/directory-tree";
import type { DirectoryNode as DirectoryDescriptor, DirectoryEntry } from "@autoforge/contracts";
import { LoadingState } from "@/components/loading-state";

import {
  apiErrorSchema,
  CASE_SUITE_ITEM_MUTATION_LIMIT,
  type CaseDirectoryFilter,
  type CaseDirectorySelection,
} from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, CaseSuite } from "@autoforge/domain";
import {
  AlertCircle,
  Check,
  Eye,
  FileCode2,
  Folder,
  Layers3,
  ListFilter,
  LoaderCircle,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useState, type SetStateAction } from "react";
import type { DirectorySelection } from "@/lib/collect-directory-selection";

import { CaseDetailContent } from "./case-detail-content";
import type { CaseDetailView } from "@/lib/case-detail-view";
import { CaseImportDialog } from "./case-import-dialog";
import { OpenRunDialogButton } from "./global-run-dialog";
import { useConfirm, useToast } from "./ui-feedback";
import {
  computeSelectionStats,
  matchesOutcomeFilter,
  type CaseLatestOutcome,
  type CaseLatestRun,
  type CaseOutcomeFilter,
} from "@/lib/case-selection-stats";
import { classifyAttemptResult, matchesCaseDirectorySearch } from "@autoforge/domain";
import {
  collectSelectableDirectoryCaseIds,
  selectionState,
  toggledSelection,
} from "@/lib/case-directory-selection";

const TREE_RENDER_PAGE_SIZE = 250;
const CASE_DELETE_PROGRESS_BATCH_SIZE = 5_000;

export function CaseSelectionTable({
  cases,
  suites,
  caseManagementProjectIds,
  suiteManagementProjectIds,
  initialSearch = "",
  latestOutcomes = new Map(),
  directoryTree,
}: {
  cases: CaseDefinitionWithMethods[];
  suites: CaseSuite[];
  caseManagementProjectIds: string[] | undefined;
  suiteManagementProjectIds: string[] | undefined;
  initialSearch?: string;
  latestOutcomes?: ReadonlyMap<string, CaseLatestRun>;
  directoryTree?: {
    filter: CaseDirectoryFilter;
    loading: boolean;
    ready: boolean;
    onFilter(filter: CaseDirectoryFilter): void;
    refresh(): void;
    source?: DirectorySource | undefined;
    projectId: string;
    caseCount: number;
    totalCount: number;
    collect(
      paths?: string[],
      signal?: AbortSignal,
      directoryPath?: string,
    ): Promise<DirectorySelection>;
  };
}) {
  const [expansion, setExpansion] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const confirmAction = useConfirm();
  const toast = useToast();
  const [selection, setSelection] = useState(
    () =>
      new Map<
        string,
        { definition: CaseDirectorySelection; outcome?: CaseLatestRun; scope?: string }
      >(),
  );
  const checkedCaseIds = useMemo(() => new Set(selection.keys()), [selection]);
  const [collecting, setCollecting] = useState(false);
  const [selectingAll, setSelectingAll] = useState<boolean>();
  const [importedOutcomes, setImportedOutcomes] = useState<ReadonlyMap<string, CaseLatestRun>>(
    new Map(),
  );
  function setCheckedCaseIds(
    update: SetStateAction<Set<string>>,
    candidates: CaseDirectorySelection[] = cases,
    outcomes = latestOutcomes,
    selectionScope: "current-filter" | "imported-paths" = "current-filter",
  ) {
    setSelection((current) => {
      const nextIds = typeof update === "function" ? update(new Set(current.keys())) : update;
      const byId = new Map(candidates.map((item) => [item.id, item]));
      const next = new Map<
        string,
        { definition: CaseDirectorySelection; outcome?: CaseLatestRun; scope?: string }
      >();
      for (const id of nextIds) {
        const previous = current.get(id);
        const definition = byId.get(id) ?? previous?.definition;
        const outcome = outcomes.get(id) ?? previous?.outcome;
        if (definition)
          next.set(id, {
            definition,
            ...(outcome ? { outcome } : {}),
            ...(selectionScope === "current-filter" && byId.has(id) && directoryTree
              ? { scope: JSON.stringify(directoryTree.filter) }
              : previous?.scope
                ? { scope: previous.scope }
                : {}),
          });
      }
      return next;
    });
  }
  const [activeCaseId, setActiveCaseId] = useState<string>();
  const [suiteId, setSuiteId] = useState(
    directoryTree?.filter.missingSuiteId ?? suites[0]?.id ?? "",
  );
  const [missingOnly, setMissingOnly] = useState(Boolean(directoryTree?.filter.missingSuiteId));
  const [missingCaseIds, setMissingCaseIds] = useState<Set<string> | null>(null);
  const [membershipPending, setMembershipPending] = useState(false);
  const [search, setSearch] = useState(initialSearch);
  const [outcomeFilter, setOutcomeFilter] = useState<CaseOutcomeFilter>(
    directoryTree?.filter.outcome ?? "all",
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [detail, setDetail] = useState<CaseDetailView | null>(null);
  const [detailError, setDetailError] = useState<{ caseId: string; message: string } | null>(null);
  const [deletedCaseIds, setDeletedCaseIds] = useState(() => new Set<string>());
  const [deletionProgress, setDeletionProgress] = useState<{
    completed: number;
    total: number;
  }>();

  const deferredSearch = useDeferredValue(search);
  const deferredOutcomeFilter = useDeferredValue(outcomeFilter);
  const filtering =
    deferredSearch !== search ||
    deferredOutcomeFilter !== outcomeFilter ||
    Boolean(directoryTree?.loading) ||
    Boolean(
      directoryTree &&
      (directoryTree.filter.query !== search ||
        directoryTree.filter.outcome !== outcomeFilter ||
        Boolean(directoryTree.filter.missingSuiteId) !== missingOnly),
    );
  const normalizedSearch = deferredSearch.trim().toLocaleLowerCase();
  const availableCases = useMemo(
    () => cases.filter((item) => !deletedCaseIds.has(item.id)),
    [cases, deletedCaseIds],
  );
  const canManageCases = (projectId: string): boolean =>
    caseManagementProjectIds === undefined || caseManagementProjectIds.includes(projectId);
  const canManageSuites = (projectId: string): boolean =>
    suiteManagementProjectIds === undefined || suiteManagementProjectIds.includes(projectId);
  const canSelectCase = (projectId: string): boolean =>
    canManageCases(projectId) || canManageSuites(projectId);
  const manageableSuites = suites.filter((suite) => canManageSuites(suite.projectId));
  const selectedProjects = new Set(
    [...selection.values()].map((item) => item.definition.projectId),
  );
  const crossProjectSelection = selectedProjects.size > 1;
  const selectedProjectId = selectedProjects.size === 1 ? [...selectedProjects][0] : undefined;
  const targetSuites = selectedProjectId
    ? manageableSuites.filter((suite) => suite.projectId === selectedProjectId)
    : manageableSuites;
  const effectiveSuiteId = targetSuites.some((suite) => suite.id === suiteId)
    ? suiteId
    : (targetSuites[0]?.id ?? "");
  const searchedCases = useMemo(
    () =>
      availableCases.filter(
        (item) =>
          (directoryTree || matchesCaseDirectorySearch(item, normalizedSearch)) &&
          (directoryTree ||
            matchesOutcomeFilter(latestOutcomes.get(item.id), deferredOutcomeFilter)),
      ),
    [availableCases, normalizedSearch, deferredOutcomeFilter, latestOutcomes, directoryTree],
  );
  const visibleCases = useMemo(
    () =>
      !directoryTree && missingOnly && missingCaseIds
        ? searchedCases.filter((item) => missingCaseIds.has(item.id))
        : searchedCases,
    [missingCaseIds, missingOnly, searchedCases, directoryTree],
  );
  const localTree = useMemo(() => buildDirectoryTree(visibleCases), [visibleCases]);
  const selectedDirectoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { definition } of selection.values()) {
      const segments = definition.directoryPath.split("/").filter(Boolean);
      for (let i = 1; i <= segments.length; i++) {
        const path = segments.slice(0, i).join("/");
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }
    return counts;
  }, [selection]);
  const [completeSelection, setCompleteSelection] = useState<{ filter: string; ids: string[] }>();
  const selectionStats = useMemo(
    () =>
      computeSelectionStats(
        checkedCaseIds,
        new Map(
          [...selection].flatMap(([id, item]) =>
            item.outcome ? [[id, item.outcome] as const] : [],
          ),
        ),
      ),
    [checkedCaseIds, selection],
  );
  const selectableCases = visibleCases.filter((item) => canSelectCase(item.projectId));
  const canSelectAnyCase = directoryTree
    ? directoryTree.caseCount > 0 && canSelectCase(directoryTree.projectId)
    : selectableCases.length > 0;
  const currentScope = directoryTree ? JSON.stringify(directoryTree.filter) : "";
  const selectedMatchingCount = directoryTree
    ? [...selection.values()].filter(
        (item) =>
          item.scope === currentScope ||
          (!directoryTree.filter.query &&
            directoryTree.filter.outcome === "all" &&
            !directoryTree.filter.missingSuiteId),
      ).length
    : 0;
  const allSelected = directoryTree
    ? directoryTree.caseCount > 0 &&
      (selectedMatchingCount === directoryTree.caseCount ||
        (completeSelection?.filter === currentScope &&
          completeSelection.ids.length > 0 &&
          completeSelection.ids.every((id) => checkedCaseIds.has(id))))
    : selectableCases.length > 0 && selectableCases.every((item) => checkedCaseIds.has(item.id));
  const selectedCases = [...selection.values()].map((item) => item.definition);
  const selectedCasesCanJoinSuite =
    selectedCases.length > 0 && selectedCases.every((item) => canManageSuites(item.projectId));
  const selectedCasesCanDelete =
    selectedCases.length > 0 && selectedCases.every((item) => canManageCases(item.projectId));
  const activeDetail = detail?.definition.id === activeCaseId ? detail : null;
  const activeDetailError =
    detailError && detailError.caseId === activeCaseId ? detailError.message : "";

  const externalQuery = directoryTree?.filter.query;
  const externalOutcome = directoryTree?.filter.outcome;
  const externalMissing = directoryTree?.filter.missingSuiteId;
  const externalFilterKey = JSON.stringify([externalQuery, externalOutcome, externalMissing]);
  const [previousExternalFilterKey, setPreviousExternalFilterKey] = useState(externalFilterKey);
  if (previousExternalFilterKey !== externalFilterKey) {
    setPreviousExternalFilterKey(externalFilterKey);
    if (externalQuery !== undefined && externalOutcome !== undefined) {
      setSearch(externalQuery);
      setOutcomeFilter(externalOutcome);
      setMissingOnly(Boolean(externalMissing));
      if (externalMissing) setSuiteId(externalMissing);
    }
  }

  useEffect(() => {
    if (!activeCaseId) return;
    const controller = new AbortController();
    void fetch(`/api/v1/case-definitions/${encodeURIComponent(activeCaseId)}/workspace`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          const parsed = apiErrorSchema.safeParse(payload);
          throw new Error(
            parsed.success
              ? parsed.data.error.message
              : `详情加载失败（HTTP ${response.status}）。`,
          );
        }
        return (await response.json()) as CaseDetailView;
      })
      .then((nextDetail) => {
        setDetail(nextDetail);
        setDetailError(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetailError({
          caseId: activeCaseId,
          message: error instanceof Error ? error.message : "用例详情加载失败。",
        });
      });
    return () => controller.abort();
  }, [activeCaseId, detailReload]);

  useEffect(() => {
    if (directoryTree || !missingOnly || !effectiveSuiteId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (availableCases.length === 0) {
        setMissingCaseIds(new Set());
        setMembershipPending(false);
        return;
      }
      setMembershipPending(true);
      setMessage(null);
      void fetch(`/api/v1/case-suites/${encodeURIComponent(effectiveSuiteId)}/cases/missing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseDefinitionIds: availableCases.map((item) => item.id) }),
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(await responseErrorMessage(response));
          return (await response.json()) as { caseDefinitionIds: string[] };
        })
        .then((result) => setMissingCaseIds(new Set(result.caseDefinitionIds)))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setMissingOnly(false);
          setMessage(error instanceof Error ? error.message : "读取任务成员失败。");
        })
        .finally(() => {
          if (!controller.signal.aborted) setMembershipPending(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [availableCases, effectiveSuiteId, missingOnly, directoryTree]);

  function importFromTable(matched: CaseDirectorySelection[], unmatchedCount: number): void {
    setCheckedCaseIds(
      (current) => {
        const next = new Set(current);
        for (const item of matched) {
          // 无管理权限的用例没有勾选框，不能通过导入间接选中。
          if (canSelectCase(item.projectId)) next.add(item.id);
        }
        return next;
      },
      matched,
      new Map([...latestOutcomes, ...importedOutcomes]),
      "imported-paths",
    );
    setMessage(
      unmatchedCount > 0
        ? `已从表格勾选 ${matched.length} 个用例，${unmatchedCount} 个路径未匹配`
        : `已从表格勾选 ${matched.length} 个用例`,
    );
  }

  function toggle(item: DirectoryEntry, outcome?: CaseLatestRun): void {
    setCheckedCaseIds(
      (current) => toggledSelection(current, [item.id]),
      [item],
      outcome ? new Map([[item.id, outcome]]) : latestOutcomes,
    );
    setMessage(null);
  }

  function toggleDirectory(ids: readonly string[]): void {
    setCheckedCaseIds((current) => toggledSelection(current, ids));
    setMessage(null);
  }

  async function selectDirectory(path?: string): Promise<void> {
    if (!directoryTree) return;
    if (path === undefined) setSelectingAll(!allSelected);
    setCollecting(true);
    try {
      const result = await directoryTree.collect(undefined, undefined, path);
      const items = result.items.filter(
        (item) => canSelectCase(item.projectId) && !deletedCaseIds.has(item.id),
      );
      const ids = items.map((item) => item.id);
      setCheckedCaseIds((current) => toggledSelection(current, ids), items, result.outcomes);
      if (path === undefined)
        setCompleteSelection({ filter: JSON.stringify(directoryTree.filter), ids });
      setMessage(null);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "读取目录用例失败。");
    } finally {
      setCollecting(false);
      setSelectingAll(undefined);
    }
  }

  async function addToSuite(): Promise<void> {
    if (
      !effectiveSuiteId ||
      checkedCaseIds.size === 0 ||
      crossProjectSelection ||
      !selectedCasesCanJoinSuite
    )
      return;
    const selectedCaseIds = [...checkedCaseIds];
    setPending(true);
    setMessage(null);
    try {
      let addedCount = 0;
      for (const caseDefinitionIds of batchesOf(selectedCaseIds, CASE_SUITE_ITEM_MUTATION_LIMIT)) {
        const response = await fetch(
          `/api/v1/case-suites/${encodeURIComponent(effectiveSuiteId)}/cases`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ caseDefinitionIds }),
          },
        );
        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          const parsed = apiErrorSchema.safeParse(payload);
          const reason = parsed.success
            ? parsed.data.error.message
            : `请求失败（HTTP ${response.status}）。`;
          throw new Error(
            addedCount > 0 ? `已加入 ${addedCount} 个用例；后续批次失败：${reason}` : reason,
          );
        }
        addedCount += caseDefinitionIds.length;
      }
      toast.success(`已将 ${selectedCaseIds.length} 个用例加入任务。`);
      directoryTree?.refresh();
      setMissingCaseIds((current) => {
        if (!current) return current;
        const next = new Set(current);
        for (const caseDefinitionId of selectedCaseIds) next.delete(caseDefinitionId);
        return next;
      });
      setCheckedCaseIds(new Set());
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "添加用例失败。");
    } finally {
      setPending(false);
    }
  }

  async function deleteCases(caseDefinitionIds: readonly string[]): Promise<void> {
    if (caseDefinitionIds.length === 0) return;
    const confirmed = await confirmAction({
      title: caseDefinitionIds.length === 1 ? "删除用例" : "批量删除用例",
      description:
        caseDefinitionIds.length === 1
          ? "这个用例会从用例库和任务成员中移除，既有执行记录仍会保留。"
          : `${caseDefinitionIds.length} 个用例会从用例库和任务成员中移除，既有执行记录仍会保留。`,
      confirmLabel: "确认删除",
      tone: "danger",
    });
    if (!confirmed) return;
    setPending(true);
    setMessage(null);
    let deletedCount = 0;
    setDeletionProgress({ completed: 0, total: caseDefinitionIds.length });
    try {
      if (caseDefinitionIds.length === 1) {
        const response = await fetch(
          `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionIds[0]!)}`,
          { method: "DELETE" },
        );
        if (!response.ok) throw new Error(await responseErrorMessage(response));
        deletedCount = 1;
        setDeletionProgress({ completed: 1, total: 1 });
      } else {
        for (const batch of batchesOf(caseDefinitionIds, CASE_DELETE_PROGRESS_BATCH_SIZE)) {
          const response = await fetch("/api/v1/case-definitions", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ caseDefinitionIds: batch }),
          });
          if (!response.ok) {
            const reason = await responseErrorMessage(response);
            throw new Error(
              deletedCount > 0 ? `已删除 ${deletedCount} 个用例；后续批次失败：${reason}` : reason,
            );
          }
          deletedCount += batch.length;
          setDeletionProgress({ completed: deletedCount, total: caseDefinitionIds.length });
        }
      }
      const removed = new Set(caseDefinitionIds);
      setDeletedCaseIds((current) => new Set([...current, ...removed]));
      setCheckedCaseIds((current) => {
        const next = new Set(current);
        for (const id of removed) next.delete(id);
        return next;
      });
      if (activeCaseId && removed.has(activeCaseId)) {
        setActiveCaseId(undefined);
        setDetail(null);
        setDetailError(null);
      }
      toast.success(`已删除 ${deletedCount} 个用例。`);
      directoryTree?.refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "删除用例失败。");
    } finally {
      setDeletionProgress(undefined);
      setPending(false);
    }
  }

  return (
    <div className="case-library-workspace">
      <section className="case-browser-pane" aria-label="用例目录工作区">
        <div className="case-browser-search">
          <Search size={17} aria-hidden="true" />
          <Input
            aria-label="页内搜索用例"
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              if (directoryTree)
                directoryTree.onFilter({
                  ...directoryTree.filter,
                  query: event.currentTarget.value,
                });
            }}
            placeholder="搜索目录、类名、方法、标签"
            type="search"
            maxLength={240}
            value={search}
          />
          {search ? (
            <Button
              onClick={() => {
                setSearch("");
                if (directoryTree) directoryTree.onFilter({ ...directoryTree.filter, query: "" });
              }}
              size="compact"
              type="button"
              variant="ghost"
            >
              清除
            </Button>
          ) : null}
          <Select
            aria-label="按最近执行结果筛选"
            onChange={(event) => {
              const outcome = parseOutcomeFilter(event.currentTarget.value);
              setOutcomeFilter(outcome);
              if (directoryTree) directoryTree.onFilter({ ...directoryTree.filter, outcome });
            }}
            value={outcomeFilter}
          >
            <option value="all">全部结果</option>
            <option value="succeeded">最近成功</option>
            <option value="failed">最近失败</option>
            <option value="blocked">最近阻塞</option>
            <option value="never">从未执行</option>
          </Select>
        </div>
        <div className="case-browser-summary">
          <span>
            {directoryTree && !directoryTree.ready
              ? "目录尚未就绪"
              : `全部 ${directoryTree?.totalCount ?? availableCases.length} 个用例`}
          </span>
          {filtering || membershipPending ? (
            <span className="list-filter-progress" role="status">
              <LoaderCircle aria-hidden="true" className="spin" size={14} />
              {membershipPending ? "正在读取任务成员" : "正在筛选"}
            </span>
          ) : normalizedSearch || deferredOutcomeFilter !== "all" || missingOnly ? (
            <strong>匹配 {directoryTree?.caseCount ?? visibleCases.length} 个</strong>
          ) : null}
        </div>

        {canSelectAnyCase || checkedCaseIds.size > 0 || missingOnly ? (
          <div className="selection-toolbar case-selection-toolbar">
            <label className="selection-actions">
              <Input
                type="checkbox"
                aria-label="选择当前搜索结果中的全部用例"
                disabled={collecting || filtering || directoryTree?.loading}
                checked={selectingAll ?? allSelected}
                onChange={() =>
                  directoryTree
                    ? void selectDirectory()
                    : setCheckedCaseIds((current) => {
                        const next = new Set(current);
                        for (const item of selectableCases) {
                          if (allSelected) next.delete(item.id);
                          else next.add(item.id);
                        }
                        return next;
                      })
                }
              />
              全选当前结果
            </label>
            <CaseImportDialog
              cases={availableCases}
              onImport={importFromTable}
              {...(directoryTree
                ? {
                    resolvePaths: async (paths: string[], signal: AbortSignal) => {
                      const result = await directoryTree.collect(paths, signal);
                      setImportedOutcomes(result.outcomes);
                      return result.items;
                    },
                  }
                : {})}
            />
            <span>
              {checkedCaseIds.size > 0
                ? `已选 ${checkedCaseIds.size}`
                : manageableSuites.length > 0
                  ? "可批量加入任务"
                  : "可批量管理用例"}
            </span>
            {selectedCasesCanDelete ? (
              <Button
                disabled={pending}
                onClick={() => deleteCases([...checkedCaseIds])}
                type="button"
                variant="danger"
              >
                {pending ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                批量删除
              </Button>
            ) : null}
            {manageableSuites.length === 0 && selectedCasesCanJoinSuite ? (
              <Link className="button button-secondary" href="/case-suites">
                <Layers3 size={15} /> 新建任务
              </Link>
            ) : manageableSuites.length > 0 ? (
              <>
                <Select
                  value={effectiveSuiteId}
                  onChange={(event) => {
                    setSuiteId(event.target.value);
                    setMissingOnly(false);
                    setMissingCaseIds(null);
                    setMembershipPending(false);
                    if (directoryTree)
                      directoryTree.onFilter({
                        query: directoryTree.filter.query,
                        outcome: directoryTree.filter.outcome,
                      });
                  }}
                  aria-label="目标用例任务"
                >
                  {targetSuites.map((suite) => (
                    <option value={suite.id} key={suite.id}>
                      {suite.name}
                    </option>
                  ))}
                </Select>
                <Button
                  aria-pressed={missingOnly}
                  disabled={!effectiveSuiteId || membershipPending}
                  onClick={() => {
                    setCheckedCaseIds(new Set());
                    const next = !missingOnly;
                    setMissingOnly(next);
                    setMissingCaseIds(null);
                    setMembershipPending(directoryTree ? false : next);
                    if (directoryTree)
                      directoryTree.onFilter({
                        query: directoryTree.filter.query,
                        outcome: directoryTree.filter.outcome,
                        ...(next ? { missingSuiteId: effectiveSuiteId } : {}),
                      });
                  }}
                  type="button"
                  variant={missingOnly ? "primary" : "secondary"}
                >
                  {membershipPending ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <ListFilter size={15} />
                  )}
                  {missingOnly ? "仅看未加入" : "筛选未加入"}
                </Button>
                <Button
                  className="button button-primary"
                  type="button"
                  disabled={
                    checkedCaseIds.size === 0 ||
                    pending ||
                    crossProjectSelection ||
                    !selectedCasesCanJoinSuite ||
                    !effectiveSuiteId
                  }
                  onClick={addToSuite}
                >
                  {pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                  加入任务
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {crossProjectSelection ? (
          <div className="inline-feedback" role="alert">
            不能跨项目混选，请取消其他项目的勾选。
          </div>
        ) : message ? (
          <div className="inline-feedback" role="status">
            {message}
          </div>
        ) : null}

        {deletionProgress ? (
          <OperationProgress
            detail={`已删除 ${deletionProgress.completed} / ${deletionProgress.total} 个用例`}
            indeterminate={deletionProgress.completed === 0}
            label="正在删除用例"
            value={
              deletionProgress.total > 0
                ? (deletionProgress.completed / deletionProgress.total) * 100
                : 0
            }
          />
        ) : null}

        {checkedCaseIds.size > 0 ? (
          <div aria-label="已勾选用例的执行统计" className="case-selection-stats" role="status">
            <span>
              已勾选 <strong>{selectionStats.total}</strong> 个用例
            </span>
            <span className="batch-status batch-status-succeeded">
              成功 {selectionStats.succeededCount}（{selectionStats.successRate}）
            </span>
            <span className="batch-status batch-status-failed">
              失败 {selectionStats.failedCount}（{selectionStats.failureRate}）
            </span>
            <span className="batch-status batch-status-blocked">
              阻塞 {selectionStats.blockedCount}（{selectionStats.blockedRate}）
            </span>
            <span className="batch-status batch-status-neutral">
              未执行 {selectionStats.notRunCount}
            </span>
          </div>
        ) : null}

        <div aria-busy={filtering} className="case-directory-scroll">
          {(directoryTree ? directoryTree.caseCount === 0 : visibleCases.length === 0) ? (
            <div className="inline-empty">
              {directoryTree && !directoryTree.ready
                ? "目录尚未就绪，完成准备后自动显示。"
                : "没有匹配的用例，尝试缩短搜索关键词。"}
            </div>
          ) : (
            <div className="case-directory-tree" role="tree" aria-label="完整用例目录">
              <DirectoryNode
                activeCaseId={activeCaseId}
                canManageProject={canSelectCase}
                forceOpen={Boolean(normalizedSearch)}
                latestOutcomes={latestOutcomes}
                key={directoryTree?.source?.projection.status.generation ?? "local"}
                expansion={expansion}
                onExpansion={(key, open) =>
                  setExpansion((current) =>
                    current.get(key) === open ? current : new Map(current).set(key, open),
                  )
                }
                node={localTree}
                source={directoryTree?.source}
                remoteOrdinal={directoryTree?.source?.projection.manifest?.rootOrdinal}
                selectedDirectoryCounts={selectedDirectoryCounts}
                onSelectDirectory={selectDirectory}
                collecting={collecting || filtering}
                canSelectDirectory={!directoryTree || canSelectCase(directoryTree.projectId)}
                deletedCaseIds={deletedCaseIds}
                onActivate={setActiveCaseId}
                onToggle={toggle}
                onToggleDirectory={toggleDirectory}
                selected={checkedCaseIds}
                root
              />
            </div>
          )}
        </div>
      </section>

      <aside className="case-inspector-pane" aria-label="用例详情与操作">
        {!activeCaseId ? (
          <div className="case-inspector-empty">
            <FileCode2 size={28} aria-hidden="true" />
            <strong>选择一个用例</strong>
            <p>详情、方法、执行与分析历史、源码及管理操作会显示在这里。</p>
          </div>
        ) : activeDetailError ? (
          <div className="case-inspector-empty" role="alert">
            <AlertCircle size={24} />
            <strong>详情加载失败</strong>
            <p>{activeDetailError}</p>
          </div>
        ) : activeDetail ? (
          <CaseInspector
            key={activeDetail.definition.id}
            detail={activeDetail}
            onDefinitionUpdated={(definition) => {
              setDetail((current) =>
                current?.definition.id === definition.id ? { ...current, definition } : current,
              );
              setDetailReload((value) => value + 1);
            }}
            onReload={() => setDetailReload((value) => value + 1)}
            onDelete={() => deleteCases([activeDetail.definition.id])}
            pending={pending}
          />
        ) : (
          <LoadingState
            label="正在加载用例详情"
            description="正在读取用例配置、版本和最近执行信息。"
          />
        )}
      </aside>
    </div>
  );
}

function CaseInspector({
  detail,
  onDefinitionUpdated,
  onReload,
  onDelete,
  pending,
}: {
  detail: CaseDetailView;
  onDefinitionUpdated(definition: CaseDefinitionWithMethods): void;
  onReload(): void;
  onDelete(): void;
  pending: boolean;
}) {
  const { definition } = detail;
  return (
    <div className="case-inspector-content">
      <header className="case-inspector-header">
        <div>
          <span className="eyebrow">Case Definition</span>
          <h2>{definition.displayName}</h2>
          <code>{definition.className}</code>
        </div>
        <div className="case-inspector-header-actions">
          <span className="storage-pill">v{definition.currentVersion}</span>
          {detail.canRun && definition.enabled && !definition.archived && detail.executable ? (
            <OpenRunDialogButton
              caseDefinitionId={definition.id}
              className="button button-primary compact-button"
            />
          ) : null}
          <Link
            className="button button-secondary compact-button"
            href={`/cases/${encodeURIComponent(definition.id)}`}
          >
            完整详情与全部历史
          </Link>
        </div>
      </header>

      <CaseDetailContent
        detail={detail}
        presentation="inspector"
        onDefinitionUpdated={onDefinitionUpdated}
        onVersionsChanged={onReload}
        managementActions={
          <div className="case-inspector-delete-action">
            <div>
              <strong>删除用例</strong>
              <p>删除当前目录、版本和任务成员关系；既有执行记录仍保留。</p>
            </div>
            <Button disabled={pending} onClick={onDelete} type="button" variant="danger">
              {pending ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
              删除用例
            </Button>
          </div>
        }
      />
    </div>
  );
}

type DirectoryTreeNode = {
  name: string;
  path: string;
  directories: DirectoryTreeNode[];
  cases: DirectoryEntry[];
  defaultOpen?: boolean;
  descriptor?: DirectoryDescriptor;
};

function buildDirectoryTree(cases: CaseDefinitionWithMethods[]): DirectoryTreeNode {
  const root: DirectoryTreeNode = { name: "", path: "", directories: [], cases: [] };
  for (const item of cases) {
    let current = root;
    for (const segment of item.directoryPath.split("/").filter(Boolean)) {
      let child = current.directories.find((candidate) => candidate.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: current.path ? `${current.path}/${segment}` : segment,
          directories: [],
          cases: [],
        };
        current.directories.push(child);
      }
      current = child;
    }
    current.cases.push({ ...item, methodCount: item.methods.length });
  }
  sortDirectory(root);
  computeDefaultExpansion(root);
  return root;
}

function sortDirectory(node: DirectoryTreeNode): void {
  node.directories.sort((left, right) => left.name.localeCompare(right.name));
  node.cases.sort((left, right) => left.displayName.localeCompare(right.displayName));
  node.directories.forEach(sortDirectory);
}

// 默认展开第一层目录；如果某层目录只有唯一子目录且没有直接用例，则继续展开，
// 直到遇到有直接用例或多个子目录的目录为止，该目录自身仍默认展开以展示其全部子项。
function computeDefaultExpansion(
  node: DirectoryTreeNode,
  depth = 0,
  parentIsSingleDirectoryChain = false,
): void {
  for (const directory of node.directories) {
    const shouldOpen =
      (depth === 0 || parentIsSingleDirectoryChain) &&
      countCases(directory) <= TREE_RENDER_PAGE_SIZE;
    directory.defaultOpen = shouldOpen;
    const continuesChain =
      shouldOpen && directory.directories.length === 1 && directory.cases.length === 0;
    computeDefaultExpansion(directory, depth + 1, continuesChain);
  }
}

function DirectoryNode({
  node,
  selected,
  activeCaseId,
  forceOpen,
  canManageProject,
  onToggle,
  onToggleDirectory,
  onActivate,
  latestOutcomes,
  source,
  expansion,
  onExpansion,
  remoteOrdinal,
  selectedDirectoryCounts,
  onSelectDirectory,
  collecting,
  canSelectDirectory,
  deletedCaseIds,
  root = false,
}: {
  node: DirectoryTreeNode;
  selected: Set<string>;
  activeCaseId: string | undefined;
  forceOpen: boolean;
  canManageProject(projectId: string): boolean;
  onToggle(item: DirectoryEntry, outcome?: CaseLatestRun): void;
  onToggleDirectory(ids: readonly string[]): void;
  onActivate(id: string): void;
  latestOutcomes: ReadonlyMap<string, CaseLatestRun>;
  source?: DirectorySource | undefined;
  expansion: ReadonlyMap<string, boolean>;
  onExpansion(key: string, open: boolean): void;
  remoteOrdinal?: number | undefined;
  selectedDirectoryCounts: ReadonlyMap<string, number>;
  onSelectDirectory(path: string): Promise<void>;
  collecting: boolean;
  canSelectDirectory: boolean;
  deletedCaseIds: ReadonlySet<string>;
  root?: boolean;
}) {
  const expansionKey = `${source?.projection.status.id ?? "local"}:${node.path}`;
  const [open, setOpen] = useState(
    expansion.get(expansionKey) ?? (root || (!source && forceOpen) || Boolean(node.defaultOpen)),
  );
  const [selecting, setSelecting] = useState<boolean>();
  const [visibleDirectoryCount, setVisibleDirectoryCount] = useState(TREE_RENDER_PAGE_SIZE);
  const [visibleCaseCount, setVisibleCaseCount] = useState(TREE_RENDER_PAGE_SIZE);

  const renderedOpen = root || open;
  const loaded = useDirectoryBranch(source, remoteOrdinal, renderedOpen);
  const directories = source
    ? loaded.branches
        .flatMap((branch) => branch.directories)
        .map(
          (descriptor) =>
            ({
              name: descriptor.name,
              path: descriptor.path,
              directories: [],
              cases: [],
              descriptor,
              defaultOpen:
                ((root && (source?.projection.manifest?.caseCount ?? 0) <= TREE_RENDER_PAGE_SIZE) ||
                  (Boolean(node.defaultOpen) &&
                    loaded.branches[0]?.directories.length === 1 &&
                    !loaded.branches[0]?.items.length)) &&
                descriptor.caseCount <= TREE_RENDER_PAGE_SIZE,
            }) satisfies DirectoryTreeNode,
        )
    : node.directories;
  const branchCases = source ? loaded.branches.flatMap((branch) => branch.items) : node.cases;
  const visibleDirectories = directories.slice(0, visibleDirectoryCount);
  const visibleNodeCases = branchCases
    .filter((item) => !deletedCaseIds.has(item.id))
    .slice(0, visibleCaseCount);
  const branchOutcomes = source
    ? new Map(
        loaded.branches
          .flatMap((branch) => branch.outcomes)
          .map((item) => [
            item.caseDefinitionId,
            { outcome: item.outcome, ...(item.resultCode ? { resultCode: item.resultCode } : {}) },
          ]),
      )
    : latestOutcomes;
  const content = (
    <div className="case-tree-children">
      {visibleDirectories.map((directory) => (
        <DirectoryNode
          source={source}
          expansion={expansion}
          onExpansion={onExpansion}
          remoteOrdinal={directory.descriptor?.ordinal}
          selectedDirectoryCounts={selectedDirectoryCounts}
          onSelectDirectory={onSelectDirectory}
          collecting={collecting}
          canSelectDirectory={canSelectDirectory}
          deletedCaseIds={deletedCaseIds}
          activeCaseId={activeCaseId}
          canManageProject={canManageProject}
          forceOpen={forceOpen}
          key={directory.path}
          latestOutcomes={latestOutcomes}
          node={directory}
          onActivate={onActivate}
          onToggle={onToggle}
          onToggleDirectory={onToggleDirectory}
          selected={selected}
        />
      ))}
      {directories.length > visibleDirectoryCount ? (
        <Button
          onClick={() => setVisibleDirectoryCount((count) => count + TREE_RENDER_PAGE_SIZE)}
          type="button"
          variant="ghost"
        >
          加载更多目录（剩余 {directories.length - visibleDirectoryCount}）
        </Button>
      ) : null}
      {visibleNodeCases.map((item) => {
        const latestRun = branchOutcomes.get(item.id);
        const outcomeLabel = latestRunBadge(latestRun);
        return (
          <div
            aria-selected={activeCaseId === item.id}
            className={`case-tree-case ${activeCaseId === item.id ? "active-case" : ""}`}
            key={item.id}
            role="treeitem"
          >
            {canManageProject(item.projectId) ? (
              <Input
                type="checkbox"
                aria-label={`选择 ${item.displayName}`}
                checked={selected.has(item.id)}
                onChange={() => onToggle(item, latestRun)}
              />
            ) : null}
            <Link
              aria-label={`查看 ${item.displayName} 详情`}
              className="case-tree-activate"
              href={`/cases/${encodeURIComponent(item.id)}`}
            >
              <FileCode2 size={16} aria-hidden="true" />
              <span>
                <strong title={item.displayName}>{item.displayName}</strong>
                <code title={item.className}>{item.className}</code>
              </span>
              <small>{item.methodCount} 个方法</small>
              {outcomeLabel ? (
                <span className={`batch-status ${outcomeBadgeClass(latestRun)}`}>
                  {outcomeLabel}
                </span>
              ) : null}
            </Link>
            <Button
              aria-label={`快速预览 ${item.displayName}`}
              className="case-tree-preview"
              onClick={() => onActivate(item.id)}
              title="在右侧快速预览"
              type="button"
              variant="ghost"
              size="compact"
            >
              <Eye size={15} aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      {branchCases.length > visibleCaseCount ? (
        <Button
          onClick={() => setVisibleCaseCount((count) => count + TREE_RENDER_PAGE_SIZE)}
          type="button"
          variant="ghost"
        >
          加载更多用例（剩余 {branchCases.length - visibleCaseCount}）
        </Button>
      ) : null}
      {loaded.loading && source ? <p role="status">正在加载目录…</p> : null}
      {loaded.error && source ? (
        <div role="alert">
          {loaded.error}
          <Button onClick={loaded.retry}>重试</Button>
        </div>
      ) : null}
      {loaded.more && source ? (
        <Button
          variant="ghost"
          disabled={loaded.loading}
          onClick={() => {
            setVisibleDirectoryCount((count) => count + TREE_RENDER_PAGE_SIZE);
            setVisibleCaseCount((count) => count + TREE_RENDER_PAGE_SIZE);
            loaded.loadMore();
          }}
        >
          加载更多
        </Button>
      ) : null}
    </div>
  );
  if (root) return content;
  const selectableIds = collectSelectableDirectoryCaseIds(node, canManageProject);
  const count = node.descriptor?.caseCount ?? countCases(node);
  const selectedCount = selectedDirectoryCounts.get(node.path) ?? 0;
  const directorySelection = source
    ? selectedCount >= count
      ? "checked"
      : selectedCount
        ? "mixed"
        : "unchecked"
    : selectionState(selected, selectableIds);
  return (
    <details
      aria-selected={false}
      className="case-tree-directory"
      onToggle={(event) => {
        onExpansion(expansionKey, event.currentTarget.open);
        setOpen(event.currentTarget.open);
      }}
      open={renderedOpen}
      role="treeitem"
    >
      <summary>
        <Input
          aria-label={`选择文件夹 ${node.path}（${source ? count : selectableIds.length} 个用例）`}
          checked={selecting ?? directorySelection === "checked"}
          disabled={collecting || !canSelectDirectory || (!source && selectableIds.length === 0)}
          onChange={async () => {
            if (!source) return onToggleDirectory(selectableIds);
            setSelecting(directorySelection !== "checked");
            try {
              await onSelectDirectory(node.path);
            } finally {
              setSelecting(undefined);
            }
          }}
          onClick={(event) => event.stopPropagation()}
          ref={(input) => {
            if (input) input.indeterminate = directorySelection === "mixed";
          }}
          type="checkbox"
        />
        <Folder size={17} aria-hidden="true" />
        <strong>{node.name}</strong>
        <span>{count} 个用例</span>
      </summary>
      {renderedOpen ? content : null}
    </details>
  );
}

function countCases(node: DirectoryTreeNode): number {
  return (
    node.cases.length +
    node.directories.reduce((total, directory) => total + countCases(directory), 0)
  );
}

const OUTCOME_BADGE_LABEL: Record<CaseLatestOutcome, string> = {
  succeeded: "最近成功",
  failed: "最近失败",
  timed_out: "最近阻塞",
  cancelled: "最近阻塞",
};

// blocked 口径：除 adapter 正常成功/失败外的非正常结束统一显示为“最近阻塞”。
function latestRunBadge(run: CaseLatestRun | undefined): string | undefined {
  if (!run) return undefined;
  const category = classifyAttemptResult(run);
  if (category === "blocked") return "最近阻塞";
  return OUTCOME_BADGE_LABEL[category];
}

function outcomeBadgeClass(run: CaseLatestRun | undefined): string {
  if (!run) return "batch-status-neutral";
  switch (classifyAttemptResult(run)) {
    case "succeeded":
      return "batch-status-succeeded";
    case "failed":
      return "batch-status-failed";
    case "blocked":
      return "batch-status-blocked";
  }
}

function parseOutcomeFilter(value: string): CaseOutcomeFilter {
  return value === "succeeded" || value === "failed" || value === "blocked" || value === "never"
    ? value
    : "all";
}

async function responseErrorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(payload);
  return parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`;
}

function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}
