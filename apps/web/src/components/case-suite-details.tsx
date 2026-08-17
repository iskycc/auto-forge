"use client";

import { Button } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseSuiteDetails } from "@autoforge/domain";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";

export function CaseSuiteDetailsView({
  canManage,
  initialSuite,
}: {
  canManage: boolean;
  initialSuite: CaseSuiteDetails;
}) {
  const [suite, setSuite] = useState(initialSuite);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function removeCase(caseDefinitionId: string): Promise<void> {
    setRemoving(caseDefinitionId);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/case-suites/${encodeURIComponent(suite.id)}/cases/${encodeURIComponent(caseDefinitionId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      setSuite((await response.json()) as CaseSuiteDetails);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "移除用例失败。");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="card table-card">
      <div className="section-title-row">
        <div>
          <span className="eyebrow">任务内容 · v{suite.version}</span>
          <h2>{suite.caseCount} 个用例</h2>
        </div>
      </div>
      {error && (
        <div className="inline-feedback error" role="alert">
          {error}
        </div>
      )}
      {suite.items.length === 0 ? (
        <div className="empty-state table-empty">
          <strong>任务中还没有用例</strong>
          <p>前往用例管理勾选测试类并加入当前任务。</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>测试类</th>
                <th>方法</th>
                <th>分组</th>
                {canManage ? <th>操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {suite.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="class-cell">
                      <strong>{item.caseDefinition.displayName}</strong>
                      <code>{item.caseDefinition.className}</code>
                    </span>
                  </td>
                  <td>{item.caseDefinition.methods.length}</td>
                  <td>
                    <span className="tag-list">
                      {item.caseDefinition.groups.map((group) => (
                        <span className="tag" key={group}>
                          {group}
                        </span>
                      ))}
                    </span>
                  </td>
                  {canManage ? (
                    <td>
                      <Button
                        className="button button-danger-quiet"
                        type="button"
                        disabled={removing === item.caseDefinition.id}
                        onClick={() => removeCase(item.caseDefinition.id)}
                      >
                        {removing === item.caseDefinition.id ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <Trash2 size={15} />
                        )}{" "}
                        移除
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
