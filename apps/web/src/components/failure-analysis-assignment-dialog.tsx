"use client";

import {
  claimFailureAnalysisResultSchema,
  failureAnalysisAssigneePageSchema,
  type ClaimFailureAnalysisResult,
} from "@autoforge/contracts";
import { LoaderCircle, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/components/ui-feedback";
import type { FailureAnalysisScope } from "@/components/start-failure-analysis-button";
import { readApiErrorMessage } from "@/lib/client-api";

type Assignee = { id: string; username: string; displayName: string };

export function FailureAnalysisAssignmentDialog({
  scope,
  executionRunIds,
  onClose,
  onAssigned,
}: {
  scope: FailureAnalysisScope;
  executionRunIds: string[];
  onClose: () => void;
  onAssigned: (result: ClaimFailureAnalysisResult) => void;
}) {
  const toast = useToast();
  const [users, setUsers] = useState<Assignee[]>([]);
  const [query, setQuery] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  const loadUsers = useCallback(
    async (search: string, nextCursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError("");
      setAssigneeId("");
      try {
        const parameters = new URLSearchParams({ projectId: scope.projectId, limit: "30" });
        if (search.trim()) parameters.set("query", search.trim());
        if (nextCursor) parameters.set("cursor", nextCursor);
        const response = await fetch(`/api/v1/failure-analysis/assignees?${parameters}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const message = await readApiErrorMessage(response, "读取分析人员失败。");
        if (message) throw new Error(message);
        const page = failureAnalysisAssigneePageSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setUsers(page.items);
          setCursor(page.nextCursor);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取分析人员失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [scope.projectId],
  );

  useEffect(() => {
    const timer = setTimeout(() => void loadUsers(""), 0);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [loadUsers]);

  async function assign(event: FormEvent) {
    event.preventDefault();
    if (!assigneeId || pending) return;
    setPending(true);
    try {
      const response = await fetch("/api/v1/failure-analysis/assignments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...scope, executionRunIds, assigneeId }),
      });
      const message = await readApiErrorMessage(response, "分配分析失败。");
      if (message) throw new Error(message);
      const result = claimFailureAnalysisResultSchema.parse(await response.json());
      const name = users.find((user) => user.id === assigneeId)?.displayName ?? "所选用户";
      if (result.conflicts.length)
        toast.warning(
          `已分配 ${result.claimed.length} 个用例给 ${name}，${result.conflicts.length} 个用例已被其他人认领。`,
        );
      else toast.success(`已分配 ${result.claimed.length} 个用例给 ${name}。`);
      onAssigned(result);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "分配分析失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <ActionDialog
      open
      onClose={() => {
        if (!pending) onClose();
      }}
      title="分配用例分析"
      description={`将选中的 ${executionRunIds.length} 个失败用例分配给现有用户。仅列出已启用且有当前项目分析权限的人员。`}
    >
      <form
        className="failure-analysis-assignee-search"
        onSubmit={(event) => {
          event.preventDefault();
          void loadUsers(query);
        }}
      >
        <Input
          aria-label="搜索分析人员"
          placeholder="姓名或账号"
          maxLength={240}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button disabled={pending} type="submit">
          <Search size={15} /> 搜索
        </Button>
      </form>
      {loading ? (
        <p role="status">
          <LoaderCircle className="spin" size={16} /> 正在读取人员…
        </p>
      ) : error ? (
        <p role="alert">
          {error}
          <Button onClick={() => void loadUsers(query)}>重试</Button>
        </p>
      ) : (
        <form onSubmit={(event) => void assign(event)}>
          <div className="failure-analysis-assignee-list">
            {users.length ? (
              users.map((user) => (
                <label className="failure-analysis-assignee-row" key={user.id}>
                  <Input
                    type="radio"
                    name="analysisAssignee"
                    checked={assigneeId === user.id}
                    onChange={() => setAssigneeId(user.id)}
                    disabled={pending}
                  />
                  <span className="failure-analysis-assignee-identity">
                    <strong>{user.displayName}</strong>
                    <span>{user.username}</span>
                  </span>
                </label>
              ))
            ) : (
              <p>没有符合条件的人员，请检查搜索条件或在项目成员管理中配置分析权限。</p>
            )}
          </div>
          <div className="button-row">
            <Button
              disabled={!cursor || pending}
              onClick={() => void loadUsers(query, cursor)}
              type="button"
            >
              更多人员
            </Button>
            <Button disabled={!assigneeId || pending} type="submit" variant="primary">
              {pending ? "正在分配…" : "确认分配"}
            </Button>
          </div>
        </form>
      )}
    </ActionDialog>
  );
}
