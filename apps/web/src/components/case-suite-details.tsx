"use client";
import { LoadingStateMessage } from "@/components/ui/loading-state-message";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { Notice } from "@/components/ui/notice";

import { EmptyState } from "@/components/ui/empty-state";

import { Disclosure } from "@/components/ui/disclosure";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button, Input } from "@/components/ui";

import type { CaseSuite } from "@autoforge/domain";
import type { DirectoryNode, SuiteDirectoryPart } from "@autoforge/contracts";
type CaseSuiteItem = SuiteDirectoryPart["items"][number];
type CaseSuiteDdtItem = SuiteDirectoryPart["ddtItems"][number];
type CaseSuiteDetails = CaseSuite & SuiteDirectoryPart;
import { ChevronRight, DatabaseZap, FolderTree, Search, Trash2 } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useConfirm } from "@/components/ui-feedback";
import { useCaseSuiteRevision } from "@/components/case-suite-revision";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { useDirectoryBranch } from "./use-directory-tree";
import type { DirectorySource } from "@/lib/directory-tree";
import { throwApiErrorResponse } from "@/lib/client-api";

const SUITE_TREE_GROUP_PAGE_SIZE = 250;
// A package row contains several interactive elements, so mounting 250 rows in one click can still
// occupy the browser main thread noticeably. Keep each expansion bounded independently from the
// number of package summaries shown on the page.
const SUITE_TREE_CASE_PAGE_SIZE = 100;

export function CaseSuiteDetailsView({
  canManage,
  initialSuite,
  directoryTree,
}: {
  canManage: boolean;
  initialSuite: CaseSuiteDetails;
  directoryTree?: {
    query: string;
    membersRevision: number;
    loading: boolean;
    onQuery(query: string): void;
    source?: DirectorySource | undefined;
    groups: DirectoryNode[];
    ordinaryCount: number;
    ddtCount: number;
    collect(ordinal?: number, kind?: "case" | "ddt"): Promise<SuiteDirectoryPart>;
  };
}) {
  const [expansion, setExpansion] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const confirmAction = useConfirm();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const { revision, acceptMutation } = useCaseSuiteRevision();
  const [suite, setSuite] = useState(initialSuite);
  const [previousInitialSuite, setPreviousInitialSuite] = useState(initialSuite);
  if (previousInitialSuite !== initialSuite) {
    setPreviousInitialSuite(initialSuite);
    if (initialSuite.revision >= suite.revision) setSuite(initialSuite);
    else if (directoryTree && directoryTree.membersRevision >= suite.revision) {
      setSuite({ ...suite, items: initialSuite.items, ddtItems: initialSuite.ddtItems });
    }
  }
  const [query, setQuery] = useState(directoryTree?.query ?? "");
  const externalQuery = directoryTree?.query;
  const [previousExternalQuery, setPreviousExternalQuery] = useState(externalQuery);
  if (previousExternalQuery !== externalQuery) {
    setPreviousExternalQuery(externalQuery);
    if (externalQuery !== undefined) setQuery(externalQuery);
  }
  const [knownMembers, setKnownMembers] = useState<SuiteDirectoryPart>({ items: [], ddtItems: [] });
  const [collecting, setCollecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedDdtIds, setSelectedDdtIds] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleGroupCount, setVisibleGroupCount] = useState(SUITE_TREE_GROUP_PAGE_SIZE);
  const deferredQuery = useDeferredValue(query);
  const filtering =
    deferredQuery !== query ||
    Boolean(directoryTree?.loading) ||
    (directoryTree !== undefined && directoryTree.query !== query);
  const visibleItems = useMemo(
    () => (directoryTree ? suite.items : filterItems(suite.items, deferredQuery)),
    [deferredQuery, suite.items, directoryTree],
  );
  const groups: Array<[string, CaseSuiteItem[]]> = directoryTree
    ? directoryTree.groups.filter((group) => group.kind === "case").map((group) => [group.name, []])
    : packageGroups(visibleItems);
  const visibleDdtItems = useMemo(
    () => (directoryTree ? suite.ddtItems : filterDdtItems(suite.ddtItems, deferredQuery)),
    [deferredQuery, suite.ddtItems, directoryTree],
  );
  const ddtGroups: Array<[string, CaseSuiteDdtItem[]]> = directoryTree
    ? directoryTree.groups.filter((group) => group.kind === "ddt").map((group) => [group.name, []])
    : srGroups(visibleDdtItems);

  const knownGroupSelections = useMemo(() => {
    const groups = new Map<string, { knownCount: number; selectedCount: number }>();
    function add(key: string, selected: boolean) {
      const count = groups.get(key) ?? { knownCount: 0, selectedCount: 0 };
      count.knownCount++;
      count.selectedCount += Number(selected);
      groups.set(key, count);
    }
    for (const item of knownMembers.items)
      add(
        `case:${item.caseDefinition.packageName || "默认包"}`,
        selectedIds.has(item.caseDefinition.id),
      );
    for (const item of knownMembers.ddtItems)
      add(`ddt:${item.ddtCase.srNum}`, selectedDdtIds.has(item.ddtCase.id));
    return groups;
  }, [knownMembers, selectedIds, selectedDdtIds]);

  async function selectMembers(kind: "case" | "ddt", ordinal?: number) {
    if (!directoryTree) return;
    setCollecting(true);
    try {
      const members = await directoryTree.collect(ordinal, kind);
      setKnownMembers((current) => ({
        items: [
          ...new Map([...current.items, ...members.items].map((item) => [item.id, item])).values(),
        ],
        ddtItems: [
          ...new Map(
            [...current.ddtItems, ...members.ddtItems].map((item) => [item.id, item]),
          ).values(),
        ],
      }));
      if (kind === "case")
        setSelectedIds((current) => toggledSelection(current, caseIds(members.items)));
      else setSelectedDdtIds((current) => toggledSelection(current, ddtCaseIds(members.ddtItems)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取任务成员失败。");
    } finally {
      setCollecting(false);
    }
  }
  function groupSource(kind: "case" | "ddt", name: string) {
    const descriptor = directoryTree?.groups.find(
      (group) => group.kind === kind && group.name === name,
    );
    if (!descriptor || !directoryTree?.source) return undefined;
    const counts = knownGroupSelections.get(`${kind}:${name}`);
    return {
      expansion,
      setExpanded: (key: string, open: boolean) =>
        setExpansion((current) =>
          current.get(key) === open ? current : new Map(current).set(key, open),
        ),
      source: directoryTree.source,
      descriptor,
      collecting: collecting || filtering,
      selectedCount: counts?.knownCount === descriptor.caseCount ? counts.selectedCount : undefined,
      select: () => selectMembers(kind, descriptor.ordinal),
    };
  }

  function toggleCase(caseDefinitionId: string): void {
    setSelectedIds((current) => toggledSelection(current, [caseDefinitionId]));
  }

  function toggleGroup(items: CaseSuiteItem[]): void {
    setSelectedIds((current) => toggledSelection(current, caseIds(items)));
  }

  async function removeCases(caseDefinitionIds: string[]): Promise<void> {
    if (caseDefinitionIds.length === 0) return;
    if (
      !(await confirmAction({
        title: "移除任务用例",
        description: `将从当前任务中移除选中的 ${caseDefinitionIds.length} 个用例，用例库中的定义不会删除。`,
        confirmLabel: "确认移除",
        tone: "danger",
      }))
    )
      return;
    setRemoving(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/cases`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseDefinitionIds }),
      });
      if (!response.ok) await throwApiErrorResponse(response, "移除用例失败。");
      const summary = (await response.json()) as CaseSuite;
      acceptMutation(revision, summary.revision);
      const removedIds = new Set(caseDefinitionIds);
      setSuite((current) => ({
        ...current,
        ...summary,
        items: current.items.filter((item) => !removedIds.has(item.caseDefinition.id)),
      }));
      setSelectedIds(new Set());
    } catch (caught) {
      if (await showConcurrentModification(caught)) return;
      setError(caught instanceof Error ? caught.message : "移除用例失败。");
    } finally {
      setRemoving(false);
    }
  }

  async function removeDdtCases(ddtCaseIds: string[]): Promise<void> {
    if (ddtCaseIds.length === 0) return;
    if (
      !(await confirmAction({
        title: "移除 DDT 用例",
        description: `将从当前任务中移除选中的 ${ddtCaseIds.length} 个 DDT 用例，DDT 用例库中的数据不会删除。`,
        confirmLabel: "确认移除",
        tone: "danger",
      }))
    )
      return;
    setRemoving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/case-suites/${encodeURIComponent(suite.id)}/ddt-cases`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ddtCaseIds }),
        },
      );
      if (!response.ok) await throwApiErrorResponse(response, "移除用例失败。");
      const summary = (await response.json()) as CaseSuite;
      acceptMutation(revision, summary.revision);
      const removedIds = new Set(ddtCaseIds);
      setSuite((current) => ({
        ...current,
        ...summary,
        ddtItems: current.ddtItems.filter((item) => !removedIds.has(item.ddtCase.id)),
      }));
      setSelectedDdtIds(new Set());
    } catch (caught) {
      if (await showConcurrentModification(caught)) return;
      setError(caught instanceof Error ? caught.message : "移除 DDT 用例失败。");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card
      as="section"
      className={cn(
        "card suite-case-tree-card",
        uiPatterns["card"],
        caseSuiteDetailsStyles["suite-case-tree-card"],
      )}
    >
      <div className={cn("section-title-row", uiPatterns["section-title-row"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>任务内容 · v{suite.version}</span>
          <h2>{suite.caseCount} 个用例</h2>
          <p>
            普通用例按包路径、DDT 用例按 SR 展开。展开目录查看用例，勾选目录可选择其中全部用例。
          </p>
        </div>
        <span className={cn("soft-icon blue", caseSuiteDetailsStyles["soft-icon"])}>
          <FolderTree size={19} />
        </span>
      </div>
      {error ? (
        <Notice
          tone="error"
          className={cn(
            "inline-feedback error",
            caseSuiteDetailsStyles["inline-feedback"],
            uiPatterns["error"],
          )}
          role="alert"
        >
          {error}
        </Notice>
      ) : null}
      {/* Mutation responses already contain the authoritative count; an empty task must not wait
          for its background directory snapshot to catch up before showing the result. */}
      {(!directoryTree || (!directoryTree.query && suite.caseCount === 0)) &&
      suite.items.length === 0 &&
      suite.ddtItems.length === 0 ? (
        <EmptyState
          className={cn(
            "empty-state table-empty",
            uiPatterns["empty-state"],
            uiPatterns["table-empty"],
          )}
        >
          <strong>任务中还没有用例</strong>
          <p>
            可添加普通用例、DDT 用例或两者混合。执行前，所有用例都必须有可用的测试类；DDT 请先完成
            SR 测试类关联。
          </p>
        </EmptyState>
      ) : (
        <>
          <div className={cn("suite-tree-toolbar", caseSuiteDetailsStyles["suite-tree-toolbar"])}>
            <label className={cn("suite-tree-search", caseSuiteDetailsStyles["suite-tree-search"])}>
              <Search aria-hidden="true" size={16} />
              <Input
                aria-label="搜索任务用例"
                onChange={(event) => {
                  setQuery(event.target.value);
                  directoryTree?.onQuery(event.target.value);
                  setVisibleGroupCount(SUITE_TREE_GROUP_PAGE_SIZE);
                }}
                placeholder="搜索用例名称、类名或包路径"
                type="search"
                value={query}
              />
            </label>
            {canManage && (groups.length > 0 || selectedIds.size > 0) ? (
              <div
                className={cn("suite-tree-actions", caseSuiteDetailsStyles["suite-tree-actions"])}
              >
                <Button
                  disabled={groups.length === 0 || removing || collecting || filtering}
                  onClick={() =>
                    directoryTree
                      ? void selectMembers("case")
                      : setSelectedIds((current) =>
                          toggledSelection(current, caseIds(visibleItems)),
                        )
                  }
                  type="button"
                >
                  {(
                    directoryTree
                      ? selectedIds.size >=
                        (directoryTree.source?.projection.manifest?.caseCount ?? Infinity)
                      : visibleItems.every((item) => selectedIds.has(item.caseDefinition.id))
                  )
                    ? "取消可见"
                    : "选择可见"}
                </Button>
                <Button
                  className={cn(
                    "button button-danger-quiet",
                    uiPatterns["button"],
                    uiPatterns["button-danger-quiet"],
                  )}
                  disabled={selectedIds.size === 0 || removing}
                  onClick={() => void removeCases([...selectedIds])}
                  type="button"
                >
                  {removing ? <LoadingIcon size={15} /> : <Trash2 size={15} />}
                  批量移除（{selectedIds.size}）
                </Button>
              </div>
            ) : null}
            {filtering ? (
              <span
                className={cn(
                  "list-filter-progress",
                  caseSuiteDetailsStyles["list-filter-progress"],
                )}
                role="status"
              >
                <LoadingIcon
                  aria-hidden="true"

                  size={14}
                />{" "}
                正在筛选
              </span>
            ) : null}
          </div>
          {directoryTree?.loading ? (
            <LoadingStateMessage role="status">
              正在准备目录，任务配置可直接编辑。
            </LoadingStateMessage>
          ) : null}
          {directoryTree && !directoryTree.loading && !groups.length && !ddtGroups.length ? (
            <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
              没有匹配的任务用例。
            </EmptyState>
          ) : null}
          {groups.length > 0 ? (
            <section
              className={cn(
                "suite-ordinary-tree-section",
                caseSuiteDetailsStyles["suite-ordinary-tree-section"],
              )}
              aria-label="普通用例树"
            >
              <div
                className={cn(
                  "suite-tree-type-heading",
                  caseSuiteDetailsStyles["suite-tree-type-heading"],
                )}
              >
                <span className={cn("soft-icon blue", caseSuiteDetailsStyles["soft-icon"])}>
                  <FolderTree size={17} />
                </span>
                <div>
                  <strong>普通用例</strong>
                  <small>
                    按包路径分组 ·{" "}
                    {directoryTree ? directoryTree.ordinaryCount : visibleItems.length} 条
                  </small>
                </div>
              </div>
              {groups.length === 0 ? (
                <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
                  没有匹配的普通用例。
                </EmptyState>
              ) : (
                <div
                  aria-busy={filtering}
                  aria-label="任务用例树"
                  className={cn("suite-case-tree", caseSuiteDetailsStyles["suite-case-tree"])}
                  role="tree"
                >
                  {groups.slice(0, visibleGroupCount).map(([packageName, items]) => (
                    <SuitePackageGroup
                      directory={groupSource("case", packageName)}
                      canManage={canManage}
                      items={items}
                      key={`${directoryTree?.source?.projection.status.generation ?? "local"}:${packageName}`}
                      onRemoveCases={removeCases}
                      onToggleCase={toggleCase}
                      onToggleGroup={toggleGroup}
                      packageName={packageName}
                      removing={removing}
                      selectedIds={selectedIds}
                    />
                  ))}
                  {groups.length > visibleGroupCount ? (
                    <Button
                      onClick={() =>
                        setVisibleGroupCount((count) => count + SUITE_TREE_GROUP_PAGE_SIZE)
                      }
                      type="button"
                      variant="ghost"
                    >
                      加载更多目录（剩余 {groups.length - visibleGroupCount}）
                    </Button>
                  ) : null}
                </div>
              )}
            </section>
          ) : null}
          {ddtGroups.length > 0 || selectedDdtIds.size > 0 ? (
            <section
              className={cn(
                "suite-ddt-tree-section",
                caseSuiteDetailsStyles["suite-ddt-tree-section"],
              )}
              aria-label="DDT 用例树"
            >
              <div
                className={cn(
                  "suite-tree-type-heading",
                  caseSuiteDetailsStyles["suite-tree-type-heading"],
                )}
              >
                <span className={cn("soft-icon violet", caseSuiteDetailsStyles["soft-icon"])}>
                  <DatabaseZap size={17} />
                </span>
                <div>
                  <strong>DDT 用例</strong>
                  <small>
                    按 SR 分组 · {directoryTree ? directoryTree.ddtCount : visibleDdtItems.length}{" "}
                    条
                  </small>
                </div>
                {canManage ? (
                  <div
                    className={cn(
                      "suite-tree-actions",
                      caseSuiteDetailsStyles["suite-tree-actions"],
                    )}
                  >
                    <Button
                      disabled={ddtGroups.length === 0 || removing || collecting || filtering}
                      onClick={() =>
                        directoryTree
                          ? void selectMembers("ddt")
                          : setSelectedDdtIds((current) =>
                              toggledSelection(current, ddtCaseIds(visibleDdtItems)),
                            )
                      }
                      type="button"
                    >
                      {(
                        directoryTree
                          ? selectedDdtIds.size > 0 &&
                            selectedDdtIds.size === directoryTree.ddtCount
                          : visibleDdtItems.every((item) => selectedDdtIds.has(item.ddtCase.id))
                      )
                        ? "取消可见"
                        : "选择可见"}
                    </Button>
                    <Button
                      className={cn(
                        "button button-danger-quiet",
                        uiPatterns["button"],
                        uiPatterns["button-danger-quiet"],
                      )}
                      disabled={selectedDdtIds.size === 0 || removing}
                      onClick={() => void removeDdtCases([...selectedDdtIds])}
                      type="button"
                    >
                      {removing ? <LoadingIcon size={15} /> : <Trash2 size={15} />}
                      批量移除（{selectedDdtIds.size}）
                    </Button>
                  </div>
                ) : null}
              </div>
              {ddtGroups.length === 0 ? (
                <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
                  没有匹配的 DDT 用例。
                </EmptyState>
              ) : (
                <div
                  className={cn("suite-case-tree", caseSuiteDetailsStyles["suite-case-tree"])}
                  role="tree"
                  aria-label="按 SR 分组的 DDT 用例"
                >
                  {ddtGroups.map(([srNum, items]) => (
                    <SuiteDdtGroup
                      directory={groupSource("ddt", srNum)}
                      canManage={canManage}
                      items={items}
                      key={`${directoryTree?.source?.projection.status.generation ?? "local"}:${srNum}`}
                      onRemoveCases={removeDdtCases}
                      onToggleCase={(id) =>
                        setSelectedDdtIds((current) => toggledSelection(current, [id]))
                      }
                      onToggleGroup={(groupItems) =>
                        setSelectedDdtIds((current) =>
                          toggledSelection(current, ddtCaseIds(groupItems)),
                        )
                      }
                      removing={removing}
                      selectedIds={selectedDdtIds}
                      srNum={srNum}
                    />
                  ))}
                </div>
              )}
            </section>
          ) : null}
        </>
      )}
    </Card>
  );
}

type LazySuiteGroup = {
  expansion: ReadonlyMap<string, boolean>;
  setExpanded(key: string, open: boolean): void;
  source: DirectorySource;
  descriptor: DirectoryNode;
  collecting: boolean;
  selectedCount?: number | undefined;
  select(): Promise<void>;
};

function SuitePackageGroup({
  canManage,
  items: initialItems,
  directory,
  onRemoveCases,
  onToggleCase,
  onToggleGroup,
  packageName,
  removing,
  selectedIds,
}: {
  directory?: LazySuiteGroup | undefined;
  canManage: boolean;
  items: CaseSuiteItem[];
  onRemoveCases(caseDefinitionIds: string[]): Promise<void>;
  onToggleCase(caseDefinitionId: string): void;
  onToggleGroup(items: CaseSuiteItem[]): void;
  packageName: string;
  removing: boolean;
  selectedIds: ReadonlySet<string>;
}) {
  // Package contents are deliberately closed on first paint. Previously every package with at most
  // 250 cases opened at once, so 250 packages could mount roughly 62,500 interactive rows. Any
  // details toggle then forced a layout pass across that entire tree and visibly froze the page.
  const expansionKey = `${directory?.source.projection.status.id}:${directory?.descriptor.kind}:${directory?.descriptor.path}`;
  const [open, setOpen] = useState(directory?.expansion.get(expansionKey) ?? false);
  const [selecting, setSelecting] = useState<boolean>();
  const branch = useDirectoryBranch(directory?.source, directory?.descriptor.ordinal, open);
  const items = useMemo(
    () => (directory ? branch.branches.flatMap((chunk) => chunk.members.items) : initialItems),
    [directory, branch.branches, initialItems],
  );
  const count = directory?.descriptor.caseCount ?? items.length;
  const [visibleCount, setVisibleCount] = useState(SUITE_TREE_CASE_PAGE_SIZE);
  // Opening/closing is local state and must not rescan a package that may contain 100,000 cases.
  const loadedSelectedCount = useMemo(
    () => items.filter((item) => selectedIds.has(item.caseDefinition.id)).length,
    [items, selectedIds],
  );
  const selectedCount = directory?.selectedCount ?? loadedSelectedCount;
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  return (
    <Disclosure
      showArrow={false}
      header={
        <>
          <ChevronRight aria-hidden="true" size={15} />
          {canManage ? (
            <Input
              aria-label={`选择包 ${packageName}`}
              checked={selecting ?? (count > 0 && selectedCount === count)}
              disabled={removing || directory?.collecting}
              onChange={async () => {
                if (!directory) return onToggleGroup(items);
                setSelecting(selectedCount !== count);
                try {
                  await directory.select();
                } finally {
                  setSelecting(undefined);
                }
              }}
              onClick={(event) => event.stopPropagation()}
              indeterminate={selectedCount > 0 && selectedCount < count}
              type="checkbox"
            />
          ) : null}
          <span className={cn("suite-tree-folder", caseSuiteDetailsStyles["suite-tree-folder"])}>
            {packageName}
          </span>
          <small>{count} 个用例</small>
        </>
      }
      aria-selected={count > 0 && selectedCount === count}
      onOpenChange={(expanded) => {
        directory?.setExpanded(expansionKey, expanded);
        setOpen(expanded);
      }}
      open={open}
      role="treeitem"
    >
      {open ? (
        <div
          className={cn("suite-tree-children", caseSuiteDetailsStyles["suite-tree-children"])}
          role="group"
        >
          {visibleItems.map((item) => (
            <div
              aria-selected={selectedIds.has(item.caseDefinition.id)}
              className={cn("suite-tree-case", caseSuiteDetailsStyles["suite-tree-case"])}
              key={item.id}
              role="treeitem"
            >
              {canManage ? (
                <Input
                  aria-label={`选择 ${item.caseDefinition.displayName}`}
                  checked={selectedIds.has(item.caseDefinition.id)}
                  onChange={() => onToggleCase(item.caseDefinition.id)}
                  type="checkbox"
                />
              ) : null}
              <span>
                <strong>{item.caseDefinition.displayName}</strong>
                <code>{item.caseDefinition.className}</code>
              </span>
              <span
                className={cn("suite-case-type testng", caseSuiteDetailsStyles["suite-case-type"])}
              >
                普通用例
              </span>
              <small>{item.caseDefinition.methodCount} 个方法</small>
              {canManage ? (
                <Button
                  aria-label={`移除 ${item.caseDefinition.displayName}`}
                  className={cn(
                    "button button-danger-quiet",
                    uiPatterns["button"],
                    uiPatterns["button-danger-quiet"],
                  )}
                  disabled={removing}
                  onClick={() => void onRemoveCases([item.caseDefinition.id])}
                  type="button"
                >
                  <Trash2 size={14} />
                </Button>
              ) : null}
            </div>
          ))}
          {branch.loading && directory ? (
            <LoadingStateMessage role="status">正在加载目录…</LoadingStateMessage>
          ) : null}
          {branch.error && directory ? (
            <Notice tone="error" role="alert">
              {branch.error}
              <Button onClick={branch.retry}>重试</Button>
            </Notice>
          ) : null}
          {branch.more && directory ? (
            <Button
              disabled={branch.loading}
              variant="ghost"
              onClick={() => {
                setVisibleCount((value) => value + SUITE_TREE_CASE_PAGE_SIZE);
                branch.loadMore();
              }}
            >
              加载更多用例
            </Button>
          ) : null}
          {items.length > visibleCount ? (
            <Button
              onClick={() => setVisibleCount((count) => count + SUITE_TREE_CASE_PAGE_SIZE)}
              type="button"
              variant="ghost"
            >
              加载更多用例（剩余 {items.length - visibleCount}）
            </Button>
          ) : null}
        </div>
      ) : null}
    </Disclosure>
  );
}

function SuiteDdtGroup({
  canManage,
  items: initialItems,
  directory,
  onRemoveCases,
  onToggleCase,
  onToggleGroup,
  removing,
  selectedIds,
  srNum,
}: {
  directory?: LazySuiteGroup | undefined;
  canManage: boolean;
  items: CaseSuiteDdtItem[];
  onRemoveCases(ids: string[]): Promise<void>;
  onToggleCase(id: string): void;
  onToggleGroup(items: CaseSuiteDdtItem[]): void;
  removing: boolean;
  selectedIds: ReadonlySet<string>;
  srNum: string;
}) {
  const expansionKey = `${directory?.source.projection.status.id}:${directory?.descriptor.kind}:${directory?.descriptor.path}`;
  const [open, setOpen] = useState(directory?.expansion.get(expansionKey) ?? false);
  const [selecting, setSelecting] = useState<boolean>();
  const branch = useDirectoryBranch(directory?.source, directory?.descriptor.ordinal, open);
  const items = useMemo(
    () => (directory ? branch.branches.flatMap((chunk) => chunk.members.ddtItems) : initialItems),
    [directory, branch.branches, initialItems],
  );
  const count = directory?.descriptor.caseCount ?? items.length;
  const [visibleCount, setVisibleCount] = useState(SUITE_TREE_CASE_PAGE_SIZE);
  const loadedSelectedCount = useMemo(
    () => items.filter((item) => selectedIds.has(item.ddtCase.id)).length,
    [items, selectedIds],
  );
  const selectedCount = directory?.selectedCount ?? loadedSelectedCount;
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  return (
    <Disclosure
      showArrow={false}
      header={
        <>
          <ChevronRight aria-hidden="true" size={15} />
          {canManage ? (
            <Input
              aria-label={`选择 SR ${srNum}`}
              checked={selecting ?? (count > 0 && selectedCount === count)}
              disabled={removing || directory?.collecting}
              onChange={async () => {
                if (!directory) return onToggleGroup(items);
                setSelecting(selectedCount !== count);
                try {
                  await directory.select();
                } finally {
                  setSelecting(undefined);
                }
              }}
              onClick={(event) => event.stopPropagation()}
              indeterminate={selectedCount > 0 && selectedCount < count}
              type="checkbox"
            />
          ) : null}
          <span className={cn("suite-tree-folder", caseSuiteDetailsStyles["suite-tree-folder"])}>
            SR · {srNum}
          </span>
          <small>{count} 个 DDT 用例</small>
        </>
      }
      aria-selected={count > 0 && selectedCount === count}
      onOpenChange={(expanded) => {
        directory?.setExpanded(expansionKey, expanded);
        setOpen(expanded);
      }}
      open={open}
      role="treeitem"
    >
      {open ? (
        <div
          className={cn("suite-tree-children", caseSuiteDetailsStyles["suite-tree-children"])}
          role="group"
        >
          {visibleItems.map((item) => (
            <div
              aria-selected={selectedIds.has(item.ddtCase.id)}
              className={cn("suite-tree-case", caseSuiteDetailsStyles["suite-tree-case"])}
              key={item.id}
              role="treeitem"
            >
              {canManage ? (
                <Input
                  aria-label={`选择 ${item.ddtCase.caseId}`}
                  checked={selectedIds.has(item.ddtCase.id)}
                  onChange={() => onToggleCase(item.ddtCase.id)}
                  type="checkbox"
                />
              ) : null}
              <span>
                <strong>{item.ddtCase.caseId}</strong>
                <code>{item.ddtCase.executionClass?.className ?? "未设置执行类"}</code>
              </span>
              <span
                className={cn("suite-case-type ddt", caseSuiteDetailsStyles["suite-case-type"])}
              >
                DDT
              </span>
              <small>{item.ddtCase.kind === "journey" ? "用户旅程" : "数据用例"}</small>
              {canManage ? (
                <Button
                  aria-label={`移除 ${item.ddtCase.caseId}`}
                  className={cn(
                    "button button-danger-quiet",
                    uiPatterns["button"],
                    uiPatterns["button-danger-quiet"],
                  )}
                  disabled={removing}
                  onClick={() => void onRemoveCases([item.ddtCase.id])}
                  type="button"
                >
                  <Trash2 size={14} />
                </Button>
              ) : null}
            </div>
          ))}
          {branch.loading && directory ? (
            <LoadingStateMessage role="status">正在加载目录…</LoadingStateMessage>
          ) : null}
          {branch.error && directory ? (
            <Notice tone="error" role="alert">
              {branch.error}
              <Button onClick={branch.retry}>重试</Button>
            </Notice>
          ) : null}
          {branch.more && directory ? (
            <Button
              disabled={branch.loading}
              variant="ghost"
              onClick={() => {
                setVisibleCount((value) => value + SUITE_TREE_CASE_PAGE_SIZE);
                branch.loadMore();
              }}
            >
              加载更多用例
            </Button>
          ) : null}
          {items.length > visibleCount ? (
            <Button
              onClick={() => setVisibleCount((count) => count + SUITE_TREE_CASE_PAGE_SIZE)}
              type="button"
              variant="ghost"
            >
              加载更多用例（剩余 {items.length - visibleCount}）
            </Button>
          ) : null}
        </div>
      ) : null}
    </Disclosure>
  );
}

function filterItems(items: CaseSuiteItem[], query: string): CaseSuiteItem[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return items;
  return items.filter((item) =>
    `${item.caseDefinition.displayName} ${item.caseDefinition.className} ${item.caseDefinition.packageName}`
      .toLocaleLowerCase("zh-CN")
      .includes(normalized),
  );
}

function packageGroups(items: CaseSuiteItem[]): Array<[string, CaseSuiteItem[]]> {
  const groups = new Map<string, CaseSuiteItem[]>();
  for (const item of items) {
    const packageName = item.caseDefinition.packageName || "默认包";
    const entries = groups.get(packageName);
    if (entries) entries.push(item);
    else groups.set(packageName, [item]);
  }
  return [...groups.entries()]
    .map(
      ([packageName, entries]) =>
        [
          packageName,
          entries.sort((left, right) =>
            left.caseDefinition.displayName.localeCompare(
              right.caseDefinition.displayName,
              "zh-CN",
            ),
          ),
        ] as [string, CaseSuiteItem[]],
    )
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"));
}

function filterDdtItems(items: CaseSuiteDdtItem[], query: string): CaseSuiteDdtItem[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return items;
  return items.filter((item) =>
    `${item.ddtCase.caseId} ${item.ddtCase.srNum} ${item.ddtCase.executionClass?.className ?? ""}`
      .toLocaleLowerCase("zh-CN")
      .includes(normalized),
  );
}

function srGroups(items: CaseSuiteDdtItem[]): Array<[string, CaseSuiteDdtItem[]]> {
  const groups = new Map<string, CaseSuiteDdtItem[]>();
  for (const item of items) {
    const entries = groups.get(item.ddtCase.srNum);
    if (entries) entries.push(item);
    else groups.set(item.ddtCase.srNum, [item]);
  }
  return [...groups.entries()]
    .map(
      ([srNum, entries]) =>
        [
          srNum,
          entries.sort((left, right) => left.ddtCase.caseId.localeCompare(right.ddtCase.caseId)),
        ] as [string, CaseSuiteDdtItem[]],
    )
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"));
}

function caseIds(items: CaseSuiteItem[]): string[] {
  return items.map((item) => item.caseDefinition.id);
}

function ddtCaseIds(items: CaseSuiteDdtItem[]): string[] {
  return items.map((item) => item.ddtCase.id);
}

function toggledSelection(current: ReadonlySet<string>, ids: string[]): ReadonlySet<string> {
  const next = new Set(current);
  const allSelected = ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allSelected) next.delete(id);
    else next.add(id);
  }
  return next;
}

const caseSuiteDetailsStyles = {
  "inline-feedback":
    "border-b border-solid border-border py-2.5 px-4.5 bg-success/10 text-success text-xs [&.error]:border-destructive/10 [&.error]:bg-destructive/10 [&.error]:text-destructive",
  "list-filter-progress": "inline-flex items-center gap-2 text-muted-foreground text-xs",
  "soft-icon":
    "inline-grid w-9.5 h-9.5 place-items-center rounded-lg [&.blue]:bg-info/10 [&.blue]:text-info [&.violet]:bg-muted [&.violet]:text-info [&.green]:bg-success/10 [&.green]:text-success [&.amber]:bg-warning/10 [&.amber]:text-warning",
  "suite-case-tree":
    'overflow-hidden border border-solid border-border rounded-xl bg-card [&_.ui-disclosure_+_.ui-disclosure]:border-t [&_.ui-disclosure_+_.ui-disclosure]:border-solid [&_.ui-disclosure_+_.ui-disclosure]:border-border [&_.ui-disclosure-label]:flex [&_.ui-disclosure-label]:min-h-11 [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-[9px] [&_.ui-disclosure-label]:py-0 [&_.ui-disclosure-label]:px-[13px] [&_.ui-disclosure-label]:bg-muted [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:[list-style:none] [&_.ui-disclosure-label::-webkit-details-marker]:hidden [&_.ui-disclosure[data-open=true]_.ui-disclosure-label_>_svg]:[transform:rotate(90deg)] [&_.ui-disclosure-label_small]:text-muted-foreground [&_.ui-disclosure-label_small]:text-xs [&_input[type="checkbox"]]:w-4 [&_input[type="checkbox"]]:h-4 [&_input[type="checkbox"]]:[accent-color:var(--info)]',
  "suite-case-tree-card": "p-5",
  "suite-case-type":
    "[&.testng]:bg-info/10 [&.testng]:text-info [&.ddt]:bg-info/10 [&.ddt]:text-info",
  "suite-ddt-tree-section": "grid gap-2.5 mt-4.5 border-t border-solid border-border pt-4",
  "suite-ordinary-tree-section": "grid gap-2.5",
  "suite-tree-actions": "flex items-center justify-between gap-3",
  "suite-tree-case":
    "[&_>_small]:text-muted-foreground [&_>_small]:text-xs grid min-h-14.5 grid-cols-[auto_minmax(0,_1fr)_auto_auto_auto] items-center gap-[11px] [padding:8px_12px_8px_36px] [&_+_.suite-tree-case]:border-t [&_+_.suite-tree-case]:border-solid [&_+_.suite-tree-case]:border-border [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-[3px] [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_code]:text-muted-foreground [&_code]:text-xs [&_>_.suite-case-type]:inline-flex [&_>_.suite-case-type]:w-fit [&_>_.suite-case-type]:items-center [&_>_.suite-case-type]:rounded-full [&_>_.suite-case-type]:py-[3px] [&_>_.suite-case-type]:px-2 [&_>_.suite-case-type]:text-xs [&_>_.suite-case-type]:font-semibold",
  "suite-tree-children": "grid",
  "suite-tree-folder":
    "min-w-0 [flex:1_1_auto] overflow-hidden font-mono text-sm font-semibold text-ellipsis whitespace-nowrap",
  "suite-tree-search":
    "flex w-[min(520px,_52%)] items-center gap-2 text-muted-foreground [&_.ui-input]:w-full max-[1181px]:w-[min(420px,_48%)]",
  "suite-tree-toolbar": "flex items-center justify-between gap-3 [margin:17px_0_12px]",
  "suite-tree-type-heading":
    "flex items-center gap-2.5 [&_>_div:not(.suite-tree-actions)]:grid [&_>_div:not(.suite-tree-actions)]:gap-0.5 [&_small]:text-muted-foreground [&_.suite-tree-actions]:ml-auto",
} as const;
