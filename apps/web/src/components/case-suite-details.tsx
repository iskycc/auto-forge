"use client";

import { Button, Input } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseSuite, CaseSuiteDetails, CaseSuiteItem } from "@autoforge/domain";
import { ChevronRight, FolderTree, LoaderCircle, Search, Trash2 } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

const SUITE_TREE_RENDER_PAGE_SIZE = 250;

export function CaseSuiteDetailsView({
  canManage,
  initialSuite,
}: {
  canManage: boolean;
  initialSuite: CaseSuiteDetails;
}) {
  const [suite, setSuite] = useState(initialSuite);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleGroupCount, setVisibleGroupCount] = useState(SUITE_TREE_RENDER_PAGE_SIZE);
  const deferredQuery = useDeferredValue(query);
  const filtering = deferredQuery !== query;
  const visibleItems = useMemo(
    () => filterItems(suite.items, deferredQuery),
    [deferredQuery, suite.items],
  );
  const groups = useMemo(() => packageGroups(visibleItems), [visibleItems]);

  function toggleCase(caseDefinitionId: string): void {
    setSelectedIds((current) => toggledSelection(current, [caseDefinitionId]));
  }

  function toggleGroup(items: CaseSuiteItem[]): void {
    setSelectedIds((current) => toggledSelection(current, caseIds(items)));
  }

  async function removeCases(caseDefinitionIds: string[]): Promise<void> {
    if (caseDefinitionIds.length === 0) return;
    if (!window.confirm(`从任务中移除选中的 ${caseDefinitionIds.length} 个用例？`)) return;
    setRemoving(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suite.id)}/cases`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseDefinitionIds }),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      const summary = (await response.json()) as CaseSuite;
      const removedIds = new Set(caseDefinitionIds);
      setSuite((current) => ({
        ...current,
        ...summary,
        items: current.items.filter((item) => !removedIds.has(item.caseDefinition.id)),
      }));
      setSelectedIds(new Set());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "移除用例失败。");
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
          <p>按包路径展开用例树，可搜索、整组选择并一次批量移除。</p>
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
      {suite.items.length === 0 ? (
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
                  setVisibleGroupCount(SUITE_TREE_RENDER_PAGE_SIZE);
                }}
                placeholder="搜索用例名称、类名或包路径"
                type="search"
                value={query}
              />
            </label>
            {canManage ? (
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
          {groups.length === 0 ? (
            <div className="inline-empty">没有匹配的任务用例。</div>
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
                    setVisibleGroupCount((count) => count + SUITE_TREE_RENDER_PAGE_SIZE)
                  }
                  type="button"
                  variant="ghost"
                >
                  加载更多目录（剩余 {groups.length - visibleGroupCount}）
                </Button>
              ) : null}
            </div>
          )}
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
  const [open, setOpen] = useState(items.length <= SUITE_TREE_RENDER_PAGE_SIZE);
  const [visibleCount, setVisibleCount] = useState(SUITE_TREE_RENDER_PAGE_SIZE);
  const selectedCount = items.filter((item) => selectedIds.has(item.caseDefinition.id)).length;
  return (
    <details
      aria-selected={selectedCount === items.length}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
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
          {items.slice(0, visibleCount).map((item) => (
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
              <small>{item.caseDefinition.methods.length} 个方法</small>
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
              onClick={() => setVisibleCount((count) => count + SUITE_TREE_RENDER_PAGE_SIZE)}
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

function caseIds(items: CaseSuiteItem[]): string[] {
  return items.map((item) => item.caseDefinition.id);
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
