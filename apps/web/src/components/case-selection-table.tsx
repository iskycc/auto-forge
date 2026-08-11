"use client";

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
}: {
  cases: CaseDefinitionWithMethods[];
  suites: CaseSuite[];
}) {
  const [selected, setSelected] = useState(() => new Set<string>());
  const [suiteId, setSuiteId] = useState(suites[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const allSelected = cases.length > 0 && selected.size === cases.length;

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
    if (!suiteId || selected.size === 0) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/case-suites/${encodeURIComponent(suiteId)}/cases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseDefinitionIds: [...selected] }),
      });
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
      <div className="selection-toolbar">
        <span>{selected.size === 0 ? "勾选用例后加入任务" : `已选择 ${selected.size} 个用例`}</span>
        {suites.length === 0 ? (
          <Link className="button button-secondary" href="/case-suites">
            <Layers3 size={15} /> 新建用例任务
          </Link>
        ) : (
          <span className="selection-actions">
            <select
              value={suiteId}
              onChange={(event) => setSuiteId(event.target.value)}
              aria-label="目标用例任务"
            >
              {suites.map((suite) => (
                <option value={suite.id} key={suite.id}>
                  {suite.name}
                </option>
              ))}
            </select>
            <button
              className="button button-primary"
              type="button"
              disabled={selected.size === 0 || pending}
              onClick={addToSuite}
            >
              {pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} 加入任务
            </button>
          </span>
        )}
      </div>
      {message && (
        <div className="inline-feedback" role="status">
          {message}
        </div>
      )}
      <div className="table-scroll">
        <table className="data-table selectable-table">
          <thead>
            <tr>
              <th className="checkbox-cell">
                <input
                  type="checkbox"
                  aria-label="选择本页全部用例"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(cases.map((item) => item.id)))
                  }
                />
              </th>
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
                <td className="checkbox-cell">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${item.displayName}`}
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                </td>
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
