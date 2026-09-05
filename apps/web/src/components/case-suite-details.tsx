"use client";

import { Button, Input } from "@/components/ui";

import type { CaseSuite } from "@autoforge/domain";
import type { SuiteDirectoryPart } from "@autoforge/contracts";
type CaseSuiteItem = SuiteDirectoryPart["items"][number];
type CaseSuiteDdtItem = SuiteDirectoryPart["ddtItems"][number];
type CaseSuiteDetails = CaseSuite & SuiteDirectoryPart;
import { ChevronRight, DatabaseZap, FolderTree, LoaderCircle, Search, Trash2 } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { useConfirm } from "@/components/ui-feedback";
import { useCaseSuiteRevision } from "@/components/case-suite-revision";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { throwApiErrorResponse } from "@/lib/client-api";

const SUITE_TREE_GROUP_PAGE_SIZE = 250;
// A package row contains several interactive elements, so mounting 250 rows in one click can still
// occupy the browser main thread noticeably. Keep each expansion bounded independently from the
// number of package summaries shown on the page.
const SUITE_TREE_CASE_PAGE_SIZE = 100;

export function CaseSuiteDetailsView({
  canManage,
  initialSuite,
}: {
  canManage: boolean;
  initialSuite: CaseSuiteDetails;
}) {
  const confirmAction = useConfirm();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const { revision, acceptMutation } = useCaseSuiteRevision();
  const [suite, setSuite] = useState(initialSuite);
  const [previousInitialSuite, setPreviousInitialSuite] = useState(initialSuite);
  if (previousInitialSuite !== initialSuite) {
    setPreviousInitialSuite(initialSuite);
    if (initialSuite.revision >= suite.revision) setSuite(initialSuite);
  }
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [selectedDdtIds, setSelectedDdtIds] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleGroupCount, setVisibleGroupCount] = useState(SUITE_TREE_GROUP_PAGE_SIZE);
  const deferredQuery = useDeferredValue(query);
  const filtering = deferredQuery !== query;
  const visibleItems = useMemo(
    () => filterItems(suite.items, deferredQuery),
    [deferredQuery, suite.items],
  );
  const groups = useMemo(() => packageGroups(visibleItems), [visibleItems]);
  const visibleDdtItems = useMemo(
    () => filterDdtItems(suite.ddtItems, deferredQuery),
    [deferredQuery, suite.ddtItems],
  );
  const ddtGroups = useMemo(() => srGroups(visibleDdtItems), [visibleDdtItems]);

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
    <section className="card suite-case-tree-card">
      <div className="section-title-row">
        <div>
          <span className="eyebrow">任务内容 · v{suite.version}</span>
          <h2>{suite.caseCount} 个用例</h2>
          <p>普通用例按包路径、DDT 用例按 SR 展开，可按类型快速识别与管理。</p>
        </div>
        <span className="soft-icon blue">
          <FolderTree size={19} />
        </span>
      </div>
      {error ? (
        <div className="inline-feedback error" role="alert">
          {error}
        </div>
      ) : null}
      {suite.items.length === 0 && suite.ddtItems.length === 0 ? (
        <div className="empty-state table-empty">
          <strong>任务中还没有用例</strong>
          <p>前往用例管理勾选测试类并加入当前任务。</p>
        </div>
      ) : (
        <>
          <div className="suite-tree-toolbar">
            <label className="suite-tree-search">
              <Search aria-hidden="true" size={16} />
              <Input
                aria-label="搜索任务用例"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleGroupCount(SUITE_TREE_GROUP_PAGE_SIZE);
                }}
                placeholder="搜索用例名称、类名或包路径"
                type="search"
                value={query}
              />
            </label>
            {canManage && suite.items.length > 0 ? (
              <div className="suite-tree-actions">
                <Button
                  disabled={visibleItems.length === 0 || removing}
                  onClick={() =>
                    setSelectedIds((current) => toggledSelection(current, caseIds(visibleItems)))
                  }
                  type="button"
                >
                  {visibleItems.every((item) => selectedIds.has(item.caseDefinition.id))
                    ? "取消可见"
                    : "选择可见"}
                </Button>
                <Button
                  className="button button-danger-quiet"
                  disabled={selectedIds.size === 0 || removing}
                  onClick={() => void removeCases([...selectedIds])}
                  type="button"
                >
                  {removing ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
                  批量移除（{selectedIds.size}）
                </Button>
              </div>
            ) : null}
            {filtering ? (
              <span className="list-filter-progress" role="status">
                <LoaderCircle aria-hidden="true" className="spin" size={14} /> 正在筛选
              </span>
            ) : null}
          </div>
          {suite.items.length > 0 ? (
            <section className="suite-ordinary-tree-section" aria-label="普通用例树">
              <div className="suite-tree-type-heading">
                <span className="soft-icon blue">
                  <FolderTree size={17} />
                </span>
                <div>
                  <strong>普通用例</strong>
                  <small>按包路径分组 · {visibleItems.length} 条</small>
                </div>
              </div>
              {groups.length === 0 ? (
                <div className="inline-empty">没有匹配的普通用例。</div>
              ) : (
                <div
                  aria-busy={filtering}
                  aria-label="任务用例树"
                  className="suite-case-tree"
                  role="tree"
                >
                  {groups.slice(0, visibleGroupCount).map(([packageName, items]) => (
                    <SuitePackageGroup
                      canManage={canManage}
                      items={items}
                      key={packageName}
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
          {suite.ddtItems.length > 0 ? (
            <section className="suite-ddt-tree-section" aria-label="DDT 用例树">
              <div className="suite-tree-type-heading">
                <span className="soft-icon violet">
                  <DatabaseZap size={17} />
                </span>
                <div>
                  <strong>DDT 用例</strong>
                  <small>按 SR 分组 · {visibleDdtItems.length} 条</small>
                </div>
                {canManage ? (
                  <div className="suite-tree-actions">
                    <Button
                      disabled={visibleDdtItems.length === 0 || removing}
                      onClick={() =>
                        setSelectedDdtIds((current) =>
                          toggledSelection(current, ddtCaseIds(visibleDdtItems)),
                        )
                      }
                      type="button"
                    >
                      {visibleDdtItems.every((item) => selectedDdtIds.has(item.ddtCase.id))
                        ? "取消可见"
                        : "选择可见"}
                    </Button>
                    <Button
                      className="button button-danger-quiet"
                      disabled={selectedDdtIds.size === 0 || removing}
                      onClick={() => void removeDdtCases([...selectedDdtIds])}
                      type="button"
                    >
                      {removing ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <Trash2 size={15} />
                      )}
                      批量移除（{selectedDdtIds.size}）
                    </Button>
                  </div>
                ) : null}
              </div>
              {ddtGroups.length === 0 ? (
                <div className="inline-empty">没有匹配的 DDT 用例。</div>
              ) : (
                <div className="suite-case-tree" role="tree" aria-label="按 SR 分组的 DDT 用例">
                  {ddtGroups.map(([srNum, items]) => (
                    <SuiteDdtGroup
                      canManage={canManage}
                      items={items}
                      key={srNum}
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
    </section>
  );
}

function SuitePackageGroup({
  canManage,
  items,
  onRemoveCases,
  onToggleCase,
  onToggleGroup,
  packageName,
  removing,
  selectedIds,
}: {
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
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(SUITE_TREE_CASE_PAGE_SIZE);
  // Opening/closing is local state and must not rescan a package that may contain 100,000 cases.
  const selectedCount = useMemo(
    () => items.filter((item) => selectedIds.has(item.caseDefinition.id)).length,
    [items, selectedIds],
  );
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  return (
    <details
      aria-selected={selectedCount === items.length}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      role="treeitem"
    >
      <summary>
        <ChevronRight aria-hidden="true" size={15} />
        {canManage ? (
          <Input
            aria-label={`选择包 ${packageName}`}
            checked={selectedCount === items.length}
            onChange={() => onToggleGroup(items)}
            onClick={(event) => event.stopPropagation()}
            ref={(input) => {
              if (input) input.indeterminate = selectedCount > 0 && selectedCount < items.length;
            }}
            type="checkbox"
          />
        ) : null}
        <span className="suite-tree-folder">{packageName}</span>
        <small>{items.length} 个用例</small>
      </summary>
      {open ? (
        <div className="suite-tree-children" role="group">
          {visibleItems.map((item) => (
            <div
              aria-selected={selectedIds.has(item.caseDefinition.id)}
              className="suite-tree-case"
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
              <span className="suite-case-type testng">普通用例</span>
              <small>{item.caseDefinition.methodCount} 个方法</small>
              {canManage ? (
                <Button
                  aria-label={`移除 ${item.caseDefinition.displayName}`}
                  className="button button-danger-quiet"
                  disabled={removing}
                  onClick={() => void onRemoveCases([item.caseDefinition.id])}
                  type="button"
                >
                  <Trash2 size={14} />
                </Button>
              ) : null}
            </div>
          ))}
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
    </details>
  );
}

function SuiteDdtGroup({
  canManage,
  items,
  onRemoveCases,
  onToggleCase,
  onToggleGroup,
  removing,
  selectedIds,
  srNum,
}: {
  canManage: boolean;
  items: CaseSuiteDdtItem[];
  onRemoveCases(ids: string[]): Promise<void>;
  onToggleCase(id: string): void;
  onToggleGroup(items: CaseSuiteDdtItem[]): void;
  removing: boolean;
  selectedIds: ReadonlySet<string>;
  srNum: string;
}) {
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(SUITE_TREE_CASE_PAGE_SIZE);
  const selectedCount = useMemo(
    () => items.filter((item) => selectedIds.has(item.ddtCase.id)).length,
    [items, selectedIds],
  );
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  return (
    <details
      aria-selected={selectedCount === items.length}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      role="treeitem"
    >
      <summary>
        <ChevronRight aria-hidden="true" size={15} />
        {canManage ? (
          <Input
            aria-label={`选择 SR ${srNum}`}
            checked={selectedCount === items.length}
            onChange={() => onToggleGroup(items)}
            onClick={(event) => event.stopPropagation()}
            ref={(input) => {
              if (input) input.indeterminate = selectedCount > 0 && selectedCount < items.length;
            }}
            type="checkbox"
          />
        ) : null}
        <span className="suite-tree-folder">SR · {srNum}</span>
        <small>{items.length} 个 DDT 用例</small>
      </summary>
      {open ? (
        <div className="suite-tree-children" role="group">
          {visibleItems.map((item) => (
            <div
              aria-selected={selectedIds.has(item.ddtCase.id)}
              className="suite-tree-case"
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
              <span className="suite-case-type ddt">DDT</span>
              <small>{item.ddtCase.kind === "journey" ? "用户旅程" : "数据用例"}</small>
              {canManage ? (
                <Button
                  aria-label={`移除 ${item.ddtCase.caseId}`}
                  className="button button-danger-quiet"
                  disabled={removing}
                  onClick={() => void onRemoveCases([item.ddtCase.id])}
                  type="button"
                >
                  <Trash2 size={14} />
                </Button>
              ) : null}
            </div>
          ))}
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
    </details>
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
