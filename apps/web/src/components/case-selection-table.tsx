"use client";

import { Button, Input, Select } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, CaseSuite, CaseVersion, Runner } from "@autoforge/domain";
import { AlertCircle, Check, FileCode2, Folder, Layers3, LoaderCircle, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { CaseDefinitionEditor } from "./case-definition-editor";
import { CaseVersionHistory } from "./case-version-history";
import { SingleCaseRun } from "./single-case-run";
import { StatusBadge } from "./status-badge";

type CaseActivity = {
  executions: Array<{
    runId: string;
    batchId: string;
    status: string;
    runnerId?: string;
    resultCode?: string;
    createdAt: string;
    finishedAt?: string;
  }>;
  analyses: Array<{
    attemptId: string;
    outcome: string;
    resultCode?: string;
    failureSignature?: string;
    passed: number;
    failed: number;
    skipped: number;
    completedAt: string;
  }>;
};

type CaseWorkspaceDetail = {
  definition: CaseDefinitionWithMethods;
  versions: CaseVersion[];
  activity: CaseActivity;
  projectVersionName: string;
  testStageName: string;
  executable: boolean;
  runners: Runner[];
  canManage: boolean;
  canRun: boolean;
  canReadSource: boolean;
  sourceView: null | {
    reference: { entryPath: string };
    content: string;
  };
  sourceViewError?: string;
};

const CASE_SUITE_UPDATE_BATCH_SIZE = 500;

export function CaseSelectionTable({
  cases,
  suites,
  manageableProjectIds,
  initialSearch = "",
}: {
  cases: CaseDefinitionWithMethods[];
  suites: CaseSuite[];
  manageableProjectIds: string[] | undefined;
  initialSearch?: string;
}) {
  const [checkedCaseIds, setCheckedCaseIds] = useState(() => new Set<string>());
  const [activeCaseId, setActiveCaseId] = useState<string>();
  const [suiteId, setSuiteId] = useState(suites[0]?.id ?? "");
  const [search, setSearch] = useState(initialSearch);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [detail, setDetail] = useState<CaseWorkspaceDetail | null>(null);
  const [detailError, setDetailError] = useState<{ caseId: string; message: string } | null>(null);

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleCases = useMemo(
    () => cases.filter((item) => matchesSearch(item, normalizedSearch)),
    [cases, normalizedSearch],
  );
  const canManageProject = (projectId: string): boolean =>
    manageableProjectIds === undefined || manageableProjectIds.includes(projectId);
  const manageableCases = visibleCases.filter((item) => canManageProject(item.projectId));
  const manageableSuites = suites.filter((suite) => canManageProject(suite.projectId));
  const canManageAnyCase = manageableCases.length > 0;
  const allSelected =
    manageableCases.length > 0 && manageableCases.every((item) => checkedCaseIds.has(item.id));
  const selectedProjects = new Set(
    cases.filter((item) => checkedCaseIds.has(item.id)).map((item) => item.projectId),
  );
  const crossProjectSelection = selectedProjects.size > 1;
  const selectedProjectId = selectedProjects.size === 1 ? [...selectedProjects][0] : undefined;
  const targetSuites = selectedProjectId
    ? manageableSuites.filter((suite) => suite.projectId === selectedProjectId)
    : manageableSuites;
  const effectiveSuiteId = targetSuites.some((suite) => suite.id === suiteId)
    ? suiteId
    : (targetSuites[0]?.id ?? "");
  const activeDetail = detail?.definition.id === activeCaseId ? detail : null;
  const activeDetailError =
    detailError && detailError.caseId === activeCaseId ? detailError.message : "";

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
        return (await response.json()) as CaseWorkspaceDetail;
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

  function toggle(id: string): void {
    setCheckedCaseIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMessage(null);
  }

  async function addToSuite(): Promise<void> {
    if (!effectiveSuiteId || checkedCaseIds.size === 0 || crossProjectSelection) return;
    const selectedCaseIds = [...checkedCaseIds];
    setPending(true);
    setMessage(null);
    try {
      let addedCount = 0;
      for (const caseDefinitionIds of batchesOf(selectedCaseIds, CASE_SUITE_UPDATE_BATCH_SIZE)) {
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
      setMessage(`已将 ${selectedCaseIds.length} 个用例加入任务。`);
      setCheckedCaseIds(new Set());
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "添加用例失败。");
    } finally {
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
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="搜索目录、类名、方法、标签"
            type="search"
            value={search}
          />
          {search ? (
            <Button onClick={() => setSearch("")} size="compact" type="button" variant="ghost">
              清除
            </Button>
          ) : null}
        </div>
        <div className="case-browser-summary">
          <span>全部 {cases.length} 个用例</span>
          {normalizedSearch ? <strong>匹配 {visibleCases.length} 个</strong> : null}
        </div>

        {canManageAnyCase ? (
          <div className="selection-toolbar case-selection-toolbar">
            <label className="selection-actions">
              <Input
                type="checkbox"
                aria-label="选择当前搜索结果中的全部用例"
                checked={allSelected}
                onChange={() =>
                  setCheckedCaseIds((current) => {
                    const next = new Set(current);
                    for (const item of manageableCases) {
                      if (allSelected) next.delete(item.id);
                      else next.add(item.id);
                    }
                    return next;
                  })
                }
              />
              全选当前结果
            </label>
            <span>
              {checkedCaseIds.size > 0 ? `已选 ${checkedCaseIds.size}` : "可批量加入任务"}
            </span>
            {manageableSuites.length === 0 ? (
              <Link className="button button-secondary" href="/case-suites">
                <Layers3 size={15} /> 新建任务
              </Link>
            ) : (
              <>
                <Select
                  value={effectiveSuiteId}
                  onChange={(event) => setSuiteId(event.target.value)}
                  aria-label="目标用例任务"
                >
                  {targetSuites.map((suite) => (
                    <option value={suite.id} key={suite.id}>
                      {suite.name}
                    </option>
                  ))}
                </Select>
                <Button
                  className="button button-primary"
                  type="button"
                  disabled={
                    checkedCaseIds.size === 0 ||
                    pending ||
                    crossProjectSelection ||
                    !effectiveSuiteId
                  }
                  onClick={addToSuite}
                >
                  {pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
                  加入任务
                </Button>
              </>
            )}
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

        <div className="case-directory-scroll">
          {visibleCases.length === 0 ? (
            <div className="inline-empty">没有匹配的用例，尝试缩短搜索关键词。</div>
          ) : (
            <div className="case-directory-tree" role="tree" aria-label="完整用例目录">
              <DirectoryNode
                activeCaseId={activeCaseId}
                canManageProject={canManageProject}
                forceOpen={Boolean(normalizedSearch)}
                node={buildDirectoryTree(visibleCases)}
                onActivate={setActiveCaseId}
                onToggle={toggle}
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
            detail={activeDetail}
            onDefinitionUpdated={(definition) =>
              setDetail((current) => (current ? { ...current, definition } : current))
            }
            onReload={() => setDetailReload((value) => value + 1)}
          />
        ) : (
          <div className="case-inspector-empty" role="status">
            <LoaderCircle className="spin" size={24} />
            <strong>正在加载用例详情</strong>
          </div>
        )}
      </aside>
    </div>
  );
}

function CaseInspector({
  detail,
  onDefinitionUpdated,
  onReload,
}: {
  detail: CaseWorkspaceDetail;
  onDefinitionUpdated(definition: CaseDefinitionWithMethods): void;
  onReload(): void;
}) {
  const { definition, activity } = detail;
  return (
    <div className="case-inspector-content">
      <header className="case-inspector-header">
        <div>
          <span className="eyebrow">Case Definition</span>
          <h2>{definition.displayName}</h2>
          <code>{definition.className}</code>
        </div>
        <span className="storage-pill">v{definition.currentVersion}</span>
      </header>

      <div className="case-inspector-meta">
        <div>
          <span>状态</span>
          <strong>
            <StatusBadge enabled={definition.enabled} />
            {definition.archived ? <span className="tag">已归档</span> : null}
          </strong>
        </div>
        <div>
          <span>版本 / 阶段</span>
          <strong>
            {detail.projectVersionName} / {detail.testStageName}
          </strong>
        </div>
        <div>
          <span>测试方法</span>
          <strong>{definition.methods.length}</strong>
        </div>
        <div>
          <span>最近更新</span>
          <strong>{formatDate(definition.updatedAt)}</strong>
        </div>
        <div className="case-inspector-meta-wide">
          <span>分组 / 标签</span>
          <strong>{[...definition.groups, ...definition.tags].join("、") || "—"}</strong>
        </div>
      </div>

      {detail.canRun && definition.enabled && !definition.archived && detail.executable ? (
        <details className="case-inspector-section">
          <summary>立即执行</summary>
          <SingleCaseRun caseDefinitionId={definition.id} runners={detail.runners} />
        </details>
      ) : null}

      {!detail.executable ? (
        <div className="implementation-notice" role="status">
          <AlertCircle size={17} aria-hidden="true" />
          该用例来自 sources JAR，只能查看与管理，不能直接执行。
        </div>
      ) : null}

      <details className="case-inspector-section" open>
        <summary>测试方法（{definition.methods.length}）</summary>
        <div className="table-scroll">
          <table className="data-table case-inspector-table">
            <thead>
              <tr>
                <th>方法</th>
                <th>分组</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {definition.methods.map((method) => (
                <tr key={method.id}>
                  <td>
                    <strong>{method.methodName}</strong>
                    <code>{method.descriptor}</code>
                  </td>
                  <td>{method.groups.join("、") || "—"}</td>
                  <td>
                    <StatusBadge enabled={method.enabled} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="case-inspector-section" open>
        <summary>执行历史（{activity.executions.length}）</summary>
        <div className="table-scroll">
          <table className="data-table case-inspector-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>状态 / 结果</th>
                <th>Runner</th>
              </tr>
            </thead>
            <tbody>
              {activity.executions.length === 0 ? (
                <tr>
                  <td colSpan={3}>当前用例尚无执行记录。</td>
                </tr>
              ) : null}
              {activity.executions.map((execution) => (
                <tr key={execution.runId}>
                  <td>
                    <Link href={`/run-batches/${encodeURIComponent(execution.batchId)}`}>
                      {formatDate(execution.finishedAt ?? execution.createdAt)}
                    </Link>
                  </td>
                  <td>
                    {execution.status} / {execution.resultCode ?? "—"}
                  </td>
                  <td>{execution.runnerId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="case-inspector-section">
        <summary>分析历史（{activity.analyses.length}）</summary>
        <div className="table-scroll">
          <table className="data-table case-inspector-table">
            <thead>
              <tr>
                <th>完成时间</th>
                <th>结果</th>
                <th>通过 / 失败 / 跳过</th>
              </tr>
            </thead>
            <tbody>
              {activity.analyses.length === 0 ? (
                <tr>
                  <td colSpan={3}>当前用例尚无分析事实。</td>
                </tr>
              ) : null}
              {activity.analyses.map((analysis) => (
                <tr key={analysis.attemptId}>
                  <td>{formatDate(analysis.completedAt)}</td>
                  <td>{analysis.resultCode ?? analysis.outcome}</td>
                  <td>
                    {analysis.passed} / {analysis.failed} / {analysis.skipped}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {detail.sourceView ? (
        <details className="case-inspector-section">
          <summary>用例源码</summary>
          <p className="muted">{detail.sourceView.reference.entryPath}</p>
          <pre className="source-code-viewer" tabIndex={0}>
            <code>{detail.sourceView.content}</code>
          </pre>
        </details>
      ) : detail.sourceViewError ? (
        <div className="inline-feedback" role="alert">
          {detail.sourceViewError}
        </div>
      ) : null}

      {detail.canManage ? (
        <details className="case-inspector-section">
          <summary>编辑用例元数据</summary>
          <CaseDefinitionEditor definition={definition} onUpdated={onDefinitionUpdated} />
        </details>
      ) : null}

      <details className="case-inspector-section">
        <summary>版本历史（{detail.versions.length}）</summary>
        <CaseVersionHistory
          canManage={detail.canManage}
          canReadSource={detail.canReadSource}
          caseDefinitionId={definition.id}
          currentVersion={definition.currentVersion}
          onChanged={onReload}
          versions={detail.versions}
        />
      </details>
    </div>
  );
}

type DirectoryTreeNode = {
  name: string;
  path: string;
  directories: DirectoryTreeNode[];
  cases: CaseDefinitionWithMethods[];
  defaultOpen?: boolean;
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
    current.cases.push(item);
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
    const shouldOpen = depth === 0 || parentIsSingleDirectoryChain;
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
  onActivate,
  root = false,
}: {
  node: DirectoryTreeNode;
  selected: Set<string>;
  activeCaseId: string | undefined;
  forceOpen: boolean;
  canManageProject(projectId: string): boolean;
  onToggle(id: string): void;
  onActivate(id: string): void;
  root?: boolean;
}) {
  const content = (
    <div className="case-tree-children">
      {node.directories.map((directory) => (
        <DirectoryNode
          activeCaseId={activeCaseId}
          canManageProject={canManageProject}
          forceOpen={forceOpen}
          key={directory.path}
          node={directory}
          onActivate={onActivate}
          onToggle={onToggle}
          selected={selected}
        />
      ))}
      {node.cases.map((item) => (
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
              onChange={() => onToggle(item.id)}
            />
          ) : null}
          <Button
            aria-label={`查看 ${item.displayName}`}
            className="case-tree-activate"
            onClick={() => onActivate(item.id)}
            type="button"
            variant="ghost"
          >
            <FileCode2 size={16} aria-hidden="true" />
            <span>
              <strong>{item.displayName}</strong>
              <code>{item.className}</code>
            </span>
            <small>{item.methods.length} 个方法</small>
          </Button>
        </div>
      ))}
    </div>
  );
  if (root) return content;
  return (
    <details
      aria-selected={false}
      className="case-tree-directory"
      open={forceOpen || node.defaultOpen ? true : undefined}
      role="treeitem"
    >
      <summary>
        <Folder size={17} aria-hidden="true" />
        <strong>{node.name}</strong>
        <span>{countCases(node)} 个用例</span>
      </summary>
      {content}
    </details>
  );
}

function countCases(node: DirectoryTreeNode): number {
  return (
    node.cases.length +
    node.directories.reduce((total, directory) => total + countCases(directory), 0)
  );
}

function matchesSearch(item: CaseDefinitionWithMethods, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  return [
    item.directoryPath,
    item.displayName,
    item.className,
    item.packageName,
    ...item.groups,
    ...item.tags,
    ...item.methods.flatMap((method) => [method.methodName, ...method.groups]),
  ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}
