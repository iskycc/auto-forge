"use client";

import { Button, Input, Select } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, CaseSuite } from "@autoforge/domain";
import { Check, FileCode2, Folder, Layers3, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { StatusBadge } from "./status-badge";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function CaseSelectionTable({
  cases,
  suites,
  manageableProjectIds,
}: {
  cases: CaseDefinitionWithMethods[];
  suites: CaseSuite[];
  manageableProjectIds: string[] | undefined;
}) {
  const [selected, setSelected] = useState(() => new Set<string>());
  const [suiteId, setSuiteId] = useState(suites[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const canManageProject = (projectId: string): boolean =>
    manageableProjectIds === undefined || manageableProjectIds.includes(projectId);
  const manageableCases = cases.filter((item) => canManageProject(item.projectId));
  const manageableSuites = suites.filter((suite) => canManageProject(suite.projectId));
  const canManageAnyCase = manageableCases.length > 0;
  const allSelected =
    manageableCases.length > 0 && manageableCases.every((item) => selected.has(item.id));
  const selectedProjects = new Set(
    cases.filter((item) => selected.has(item.id)).map((item) => item.projectId),
  );
  const crossProjectSelection = selectedProjects.size > 1;
  const selectedProjectId = selectedProjects.size === 1 ? [...selectedProjects][0] : undefined;
  const targetSuites = selectedProjectId
    ? manageableSuites.filter((suite) => suite.projectId === selectedProjectId)
    : manageableSuites;
  const effectiveSuiteId = targetSuites.some((suite) => suite.id === suiteId)
    ? suiteId
    : (targetSuites[0]?.id ?? "");

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setMessage(null);
  }

  async function addToSuite(): Promise<void> {
    if (!effectiveSuiteId || selected.size === 0 || crossProjectSelection) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/v1/case-suites/${encodeURIComponent(effectiveSuiteId)}/cases`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseDefinitionIds: [...selected] }),
        },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      setMessage(`已将 ${selected.size} 个用例加入任务。`);
      setSelected(new Set());
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "添加用例失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {canManageAnyCase ? (
        <div className="selection-toolbar">
          <span>
            {crossProjectSelection
              ? "不能跨项目混选，请先按项目筛选或取消其他项目的勾选"
              : selected.size === 0
                ? "勾选用例后加入任务"
                : `已选择 ${selected.size} 个用例`}
          </span>
          <label className="selection-actions">
            <Input
              type="checkbox"
              aria-label="选择当前目录树全部用例"
              checked={allSelected}
              onChange={() =>
                setSelected(
                  allSelected ? new Set() : new Set(manageableCases.map((item) => item.id)),
                )
              }
            />
            全选
          </label>
          {manageableSuites.length === 0 ? (
            <Link className="button button-secondary" href="/case-suites">
              <Layers3 size={15} /> 新建用例任务
            </Link>
          ) : (
            <span className="selection-actions">
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
                  selected.size === 0 || pending || crossProjectSelection || !effectiveSuiteId
                }
                onClick={addToSuite}
              >
                {pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{" "}
                加入任务
              </Button>
            </span>
          )}
        </div>
      ) : null}
      {message && (
        <div className="inline-feedback" role="status">
          {message}
        </div>
      )}
      <div className="case-directory-tree" role="tree" aria-label="用例目录">
        <DirectoryNode
          node={buildDirectoryTree(cases)}
          selected={selected}
          canManageProject={canManageProject}
          onToggle={toggle}
          root
        />
      </div>
    </>
  );
}

type DirectoryTreeNode = {
  name: string;
  path: string;
  directories: DirectoryTreeNode[];
  cases: CaseDefinitionWithMethods[];
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
  return root;
}

function sortDirectory(node: DirectoryTreeNode): void {
  node.directories.sort((left, right) => left.name.localeCompare(right.name));
  node.cases.sort((left, right) => left.displayName.localeCompare(right.displayName));
  node.directories.forEach(sortDirectory);
}

function DirectoryNode({
  node,
  selected,
  canManageProject,
  onToggle,
  root = false,
}: {
  node: DirectoryTreeNode;
  selected: Set<string>;
  canManageProject(projectId: string): boolean;
  onToggle(id: string): void;
  root?: boolean;
}) {
  const content = (
    <div className="case-tree-children">
      {node.directories.map((directory) => (
        <DirectoryNode
          key={directory.path}
          node={directory}
          selected={selected}
          canManageProject={canManageProject}
          onToggle={onToggle}
        />
      ))}
      {node.cases.map((item) => (
        <div
          aria-selected={selected.has(item.id)}
          className={`case-tree-case ${selected.has(item.id) ? "selected-row" : ""}`}
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
          <FileCode2 size={17} aria-hidden="true" />
          <span className="class-cell">
            <strong>
              <Link className="table-link" href={`/cases/${encodeURIComponent(item.id)}`}>
                {item.displayName}
              </Link>
            </strong>
            <code>{item.className}</code>
          </span>
          <span className="method-summary">
            <strong>{item.methods.length}</strong>
            <span>个测试方法</span>
          </span>
          <span className="tag-list">
            {item.groups.slice(0, 3).map((group) => (
              <span className="tag" key={group}>
                {group}
              </span>
            ))}
          </span>
          <StatusBadge enabled={item.enabled} />
          <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
        </div>
      ))}
    </div>
  );
  if (root) return content;
  return (
    <details aria-selected={false} className="case-tree-directory" open role="treeitem">
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
