"use client";

import { Button } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseSourceComparisonResult } from "@autoforge/contracts";
import { Archive, GitCompareArrows, LoaderCircle, RefreshCcw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

const PREVIEW_ENTRY_LIMIT = 10;

type SourceLifecyclePanelProps = {
  sourceId: string;
  authoritative: boolean;
  status: "ready" | "failed";
  lifecycleStatus: "active" | "archived" | "deleting";
  revision: number;
};

// 来源对比同步、归档/恢复与删除操作。同步采用“保留”语义：
// 切换权威来源不会自动禁用或归档候选中已消失的用例。
export function SourceLifecyclePanel({
  sourceId,
  authoritative,
  status,
  lifecycleStatus,
  revision,
}: SourceLifecyclePanelProps) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [comparison, setComparison] = useState<CaseSourceComparisonResult | null>(null);

  const comparable = !authoritative && status === "ready" && lifecycleStatus === "active";

  async function run(action: string, operation: () => Promise<void>): Promise<void> {
    setPendingAction(action);
    setError(null);
    setMessage(null);
    try {
      await operation();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
    } finally {
      setPendingAction(null);
    }
  }

  async function request(path: string, method: string, body?: unknown): Promise<void> {
    const response = await fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const parsed = apiErrorSchema.safeParse(payload);
      throw new Error(
        parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
      );
    }
  }

  function compare(): Promise<void> {
    return run("compare", async () => {
      const response = await fetch(
        `/api/v1/case-sources/${encodeURIComponent(sourceId)}/comparisons`,
        { method: "POST" },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      setComparison((await response.json()) as CaseSourceComparisonResult);
    });
  }

  function confirmSync(): Promise<void> {
    if (!comparison) return Promise.resolve();
    return run("sync", async () => {
      await request(`/api/v1/case-sources/${encodeURIComponent(sourceId)}/sync`, "POST", {
        comparisonId: comparison.id,
        expectedRevision: revision,
      });
      setComparison(null);
      setMessage("已切换为权威来源。");
    });
  }

  function setArchived(archived: boolean): Promise<void> {
    return run(archived ? "archive" : "restore", async () => {
      await request(`/api/v1/case-sources/${encodeURIComponent(sourceId)}`, "PATCH", {
        archived,
        expectedRevision: revision,
      });
      setComparison(null);
      setMessage(archived ? "来源已归档。" : "来源已恢复为活跃状态。");
    });
  }

  function remove(): Promise<void> {
    return run("delete", async () => {
      if (!window.confirm("确认删除该来源？将异步删除其 JAR 对象，此操作不可撤销。")) return;
      await request(`/api/v1/case-sources/${encodeURIComponent(sourceId)}`, "DELETE", {
        expectedRevision: revision,
      });
      setMessage("来源已标记删除，JAR 对象将由后台任务清理。");
    });
  }

  return (
    <section className="card">
      <div className="section-title-row">
        <div>
          <span className="eyebrow">来源生命周期</span>
          <h2>对比同步与归档删除</h2>
        </div>
      </div>
      <div className="inline-action-stack">
        {comparable && (
          <Button
            className="button button-secondary"
            type="button"
            disabled={pendingAction !== null}
            onClick={() => void compare()}
          >
            {pendingAction === "compare" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <GitCompareArrows size={15} />
            )}
            对比权威来源
          </Button>
        )}
        {lifecycleStatus === "active" && (
          <Button
            className="button button-secondary"
            type="button"
            disabled={pendingAction !== null}
            onClick={() => void setArchived(true)}
          >
            {pendingAction === "archive" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Archive size={15} />
            )}
            归档来源
          </Button>
        )}
        {lifecycleStatus === "archived" && (
          <Button
            className="button button-secondary"
            type="button"
            disabled={pendingAction !== null}
            onClick={() => void setArchived(false)}
          >
            {pendingAction === "restore" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <RefreshCcw size={15} />
            )}
            恢复为活跃
          </Button>
        )}
        {!authoritative && lifecycleStatus === "active" && (
          <Button
            className="danger-text-button"
            type="button"
            disabled={pendingAction !== null}
            onClick={() => void remove()}
          >
            {pendingAction === "delete" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Trash2 size={15} />
            )}
            删除来源
          </Button>
        )}
        {lifecycleStatus === "deleting" && <small>来源正在删除，JAR 对象将由后台任务清理。</small>}
      </div>
      {comparison && (
        <div className="comparison-result">
          <p>
            对比结果：新增 {comparison.added.length}、变更 {comparison.changed.length}、消失{" "}
            {comparison.removed.length}、冲突 {comparison.conflicts.length}
            {comparison.truncated ? "（名单已达上限被截断，仅显示部分）" : ""}。
            同步只切换权威来源，不会自动禁用或归档已消失的用例。
          </p>
          <ComparisonPreview
            title="新增"
            entries={comparison.added.map((entry) => entry.className)}
          />
          <ComparisonPreview
            title="变更"
            entries={comparison.changed.map((entry) => entry.className)}
          />
          <ComparisonPreview
            title="消失"
            entries={comparison.removed.map((entry) => entry.className)}
          />
          <ComparisonPreview
            title="冲突"
            entries={comparison.conflicts.map((entry) => entry.className)}
          />
          <div className="inline-action-stack">
            <Button
              className="button button-success"
              type="button"
              disabled={pendingAction !== null}
              onClick={() => void confirmSync()}
            >
              {pendingAction === "sync" ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <GitCompareArrows size={15} />
              )}
              确认同步为权威来源
            </Button>
          </div>
        </div>
      )}
      {error && <small className="inline-error">{error}</small>}
      {message && <small>{message}</small>}
    </section>
  );
}

function ComparisonPreview({ title, entries }: { title: string; entries: string[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="method-list">
      <div className="method-row">
        <span className="method-origin">{title}</span>
        <code>
          {entries.slice(0, PREVIEW_ENTRY_LIMIT).join("，")}
          {entries.length > PREVIEW_ENTRY_LIMIT ? ` 等 ${entries.length} 个` : ""}
        </code>
      </div>
    </div>
  );
}
