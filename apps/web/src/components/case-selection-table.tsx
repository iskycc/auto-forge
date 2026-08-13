"use client";

import { Button, Input, Select } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, CaseSuite } from "@autoforge/domain";
import { Check, Layers3, LoaderCircle } from "lucide-react";
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
      <div className="table-scroll">
        <table className="data-table selectable-table">
          <thead>
            <tr>
              {canManageAnyCase ? (
                <th className="checkbox-cell">
                  <Input
                    type="checkbox"
                    aria-label="选择本页全部用例"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(
                        allSelected ? new Set() : new Set(manageableCases.map((item) => item.id)),
                      )
                    }
                  />
                </th>
              ) : null}
              <th>测试类</th>
              <th>测试方法</th>
              <th>分组</th>
              <th>状态</th>
              <th>导入时间</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((item) => (
              <tr className={selected.has(item.id) ? "selected-row" : ""} key={item.id}>
                {canManageAnyCase ? (
                  <td className="checkbox-cell">
                    {canManageProject(item.projectId) ? (
                      <Input
                        type="checkbox"
                        aria-label={`选择 ${item.displayName}`}
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                      />
                    ) : null}
                  </td>
                ) : null}
                <td>
                  <span className="class-cell">
                    <strong>
                      <Link className="table-link" href={`/cases/${encodeURIComponent(item.id)}`}>
                        {item.displayName}
                      </Link>
                    </strong>
                    <code>{item.className}</code>
                  </span>
                </td>
                <td>
                  <span className="method-summary">
                    <strong>{item.methods.length}</strong>
                    <span>
                      {item.methods
                        .slice(0, 2)
                        .map((method) => method.methodName)
                        .join("、") || "类级定义"}
                    </span>
                  </span>
                </td>
                <td>
                  <span className="tag-list">
                    {item.groups.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      item.groups.slice(0, 3).map((group) => (
                        <span className="tag" key={group}>
                          {group}
                        </span>
                      ))
                    )}
                  </span>
                </td>
                <td>
                  <StatusBadge enabled={item.enabled} />
                </td>
                <td>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
