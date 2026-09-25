"use client";
import { LoadingIcon } from "@/components/ui/loading-icon";

import { EmptyState } from "@/components/ui/empty-state";

import { Notice } from "@/components/ui/notice";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { Runner, RunnerGroup } from "@autoforge/domain";
import { Pencil, Plus, Server, Trash2, UsersRound, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button, CheckboxGroup, Input, Textarea } from "./ui";
import { ActionDialog } from "./action-dialog";
import { useConcurrentModificationFeedback } from "./concurrent-modification-feedback";
import { useConfirm, useToast } from "./ui-feedback";
import { throwApiErrorResponse } from "@/lib/client-api";

export function RunnerGroupManager({
  initialGroups,
  runners,
  canManage,
}: {
  initialGroups: RunnerGroup[];
  runners: Runner[];
  canManage: boolean;
}) {
  const confirmAction = useConfirm();
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [groups, setGroups] = useState(initialGroups);
  const [editingGroupId, setEditingGroupId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (form.getAll("runnerIds").length > 64) {
      setError("每个执行机组最多选择 64 台执行机。");
      return;
    }
    setPending(true);
    setError("");
    try {
      const group = await requestJson<RunnerGroup>("/api/v1/runner-groups", {
        method: "POST",
        body: {
          name: form.get("name"),
          description: form.get("description"),
          runnerIds: form.getAll("runnerIds"),
        },
      });
      setGroups((current) => [...current, group].sort(compareGroups));
      formElement.reset();
      setCreateOpen(false);
      toast.success("执行机组已创建。");
    } catch (problem) {
      if (await showConcurrentModification(problem)) return;
      setError(problem instanceof Error ? problem.message : "创建执行机组失败。");
    } finally {
      setPending(false);
    }
  }

  async function update(group: RunnerGroup, event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.getAll("runnerIds").length > 64) {
      setError("每个执行机组最多选择 64 台执行机。");
      return;
    }
    setPending(true);
    setError("");
    try {
      const updated = await requestJson<RunnerGroup>(
        `/api/v1/runner-groups/${encodeURIComponent(group.id)}`,
        {
          method: "PATCH",
          body: {
            name: form.get("name"),
            description: form.get("description"),
            runnerIds: form.getAll("runnerIds"),
            expectedRevision: group.revision,
          },
        },
      );
      setGroups((current) =>
        current
          .map((candidate) => (candidate.id === updated.id ? updated : candidate))
          .sort(compareGroups),
      );
      setEditingGroupId(undefined);
      toast.success("执行机组已更新。");
    } catch (problem) {
      if (await showConcurrentModification(problem)) return;
      setError(problem instanceof Error ? problem.message : "更新执行机组失败。");
    } finally {
      setPending(false);
    }
  }

  async function remove(group: RunnerGroup): Promise<void> {
    if (
      !(await confirmAction({
        title: "删除执行机组",
        description: `确认删除执行机组“${group.name}”？历史批次的执行机快照不会改变。`,
        confirmLabel: "确认删除",
        tone: "danger",
      }))
    )
      return;
    setPending(true);
    setError("");
    try {
      await requestJson(`/api/v1/runner-groups/${encodeURIComponent(group.id)}`, {
        method: "DELETE",
      });
      setGroups((current) => current.filter((candidate) => candidate.id !== group.id));
      toast.success("执行机组已删除。");
    } catch (problem) {
      if (await showConcurrentModification(problem)) return;
      setError(problem instanceof Error ? problem.message : "删除执行机组失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={cn("runner-group-manager", runnerGroupManagerStyles["runner-group-manager"])}>
      {canManage ? (
        <div
          className={cn("runner-group-toolbar", runnerGroupManagerStyles["runner-group-toolbar"])}
        >
          <span>按机房、网络区域或能力维护可复用资源池。</span>
          <Button
            onClick={() => {
              setError("");
              setCreateOpen(true);
            }}
            type="button"
            variant="primary"
          >
            <Plus size={16} /> 创建机组
          </Button>
        </div>
      ) : null}
      <ActionDialog
        protectUnsavedChanges
        description="按机房、网络区域或能力维护可复用资源池。"
        onClose={() => !pending && setCreateOpen(false)}
        open={createOpen}
        title="新建执行机组"
      >
        <form
          className={cn("action-dialog-form", runnerGroupManagerStyles["action-dialog-form"])}
          onSubmit={(event) => void create(event)}
        >
          <div
            className={cn("runner-group-fields", runnerGroupManagerStyles["runner-group-fields"])}
          >
            <label className={cn("field-stack", uiPatterns["field-stack"])}>
              <span>组名称</span>
              <Input maxLength={120} name="name" required />
            </label>
            <label
              className={cn(
                "field-stack runner-group-description",
                uiPatterns["field-stack"],
                runnerGroupManagerStyles["runner-group-description"],
              )}
            >
              <span>说明</span>
              <Textarea maxLength={500} name="description" rows={2} />
            </label>
          </div>
          {error ? (
            <Notice
              tone="error"
              className={cn("form-error", uiPatterns["form-error"])}
              role="alert"
            >
              {error}
            </Notice>
          ) : null}
          <RunnerMemberPicker runners={runners} selectedRunnerIds={[]} />
          <Button disabled={pending} type="submit" variant="primary">
            {pending ? <LoadingIcon size={16} /> : <Plus size={16} />}
            创建执行机组
          </Button>
        </form>
      </ActionDialog>

      {error && !createOpen && !editingGroupId ? (
        <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
          {error}
        </Notice>
      ) : null}

      <Card
        as="section"
        className={cn(
          "card runner-group-list-card",
          uiPatterns["card"],
          runnerGroupManagerStyles["runner-group-list-card"],
        )}
      >
        <div className={cn("section-title-row", uiPatterns["section-title-row"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>RESOURCE POOLS</span>
            <h2>执行机组</h2>
          </div>
          <span className={cn("table-count", runnerGroupManagerStyles["table-count"])}>
            共 {groups.length} 组
          </span>
        </div>
        {groups.length === 0 ? (
          <EmptyState
            className={cn(
              "empty-state table-empty",
              uiPatterns["empty-state"],
              uiPatterns["table-empty"],
            )}
          >
            <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
              <UsersRound size={25} />
            </span>
            <strong>尚未创建执行机组</strong>
            <p>创建后，发起任务批跑和单用例执行时都可以直接选择整组资源。</p>
          </EmptyState>
        ) : (
          <div className={cn("runner-group-grid", runnerGroupManagerStyles["runner-group-grid"])}>
            {groups.map((group) =>
              editingGroupId === group.id ? (
                <ActionDialog
                  key={group.id}
                  open
                  protectUnsavedChanges
                  title={`编辑执行机组：${group.name}`}
                  onClose={() => !pending && setEditingGroupId(undefined)}
                >
                  <form
                    className={cn(
                      "action-dialog-form",
                      runnerGroupManagerStyles["action-dialog-form"],
                    )}
                    onSubmit={(event) => void update(group, event)}
                  >
                    <div
                      className={cn(
                        "runner-group-fields",
                        runnerGroupManagerStyles["runner-group-fields"],
                      )}
                    >
                      <label className={cn("field-stack", uiPatterns["field-stack"])}>
                        <span>组名称</span>
                        <Input defaultValue={group.name} maxLength={120} name="name" required />
                      </label>
                      <label
                        className={cn(
                          "field-stack runner-group-description",
                          uiPatterns["field-stack"],
                          runnerGroupManagerStyles["runner-group-description"],
                        )}
                      >
                        <span>说明</span>
                        <Textarea
                          defaultValue={group.description}
                          maxLength={500}
                          name="description"
                          rows={2}
                        />
                      </label>
                    </div>
                    {error ? (
                      <Notice
                        tone="error"
                        className={cn("form-error", uiPatterns["form-error"])}
                        role="alert"
                      >
                        {error}
                      </Notice>
                    ) : null}
                    <RunnerMemberPicker runners={runners} selectedRunnerIds={group.runnerIds} />
                    <div
                      className={cn(
                        "runner-group-actions",
                        runnerGroupManagerStyles["runner-group-actions"],
                      )}
                    >
                      <Button disabled={pending} type="submit" variant="primary">
                        保存修改
                      </Button>
                      <Button
                        data-dialog-dismiss
                        onClick={() => setEditingGroupId(undefined)}
                        type="button"
                      >
                        <X size={15} /> 取消
                      </Button>
                    </div>
                  </form>
                </ActionDialog>
              ) : (
                <article
                  className={cn("runner-group-card", runnerGroupManagerStyles["runner-group-card"])}
                  key={group.id}
                >
                  <header>
                    <span
                      className={cn(
                        "runner-group-icon",
                        runnerGroupManagerStyles["runner-group-icon"],
                      )}
                    >
                      <UsersRound size={19} />
                    </span>
                    <span>
                      <strong className="line-clamp-2" title={group.name}>
                        {group.name}
                      </strong>
                      <small className="line-clamp-3" title={group.description || undefined}>
                        {group.description || "未填写说明"}
                      </small>
                    </span>
                    <b>{group.runnerIds.length} 台</b>
                  </header>
                  <div
                    className={cn(
                      "runner-group-members",
                      runnerGroupManagerStyles["runner-group-members"],
                    )}
                  >
                    {group.runnerIds.length === 0 ? (
                      <span className={cn("muted", uiPatterns["muted"])}>当前没有成员</span>
                    ) : (
                      group.runnerIds.map((runnerId) => {
                        const runner = runners.find((candidate) => candidate.id === runnerId);
                        return (
                          <span key={runnerId}>
                            <Server size={14} /> {runner?.name ?? runnerId}
                            <i
                              className={cn(
                                runnerGroupManagerStyles["dot"],
                                `dot ${runner?.state === "online" ? cn("green-dot", runnerGroupManagerStyles["green-dot"]) : cn("gray-dot", runnerGroupManagerStyles["gray-dot"])}`,
                              )}
                            />
                          </span>
                        );
                      })
                    )}
                  </div>
                  {canManage ? (
                    <footer
                      className={cn(
                        "runner-group-actions",
                        runnerGroupManagerStyles["runner-group-actions"],
                      )}
                    >
                      <Button
                        onClick={() => {
                          setError("");
                          setEditingGroupId(group.id);
                        }}
                        type="button"
                      >
                        <Pencil size={15} /> 编辑
                      </Button>
                      <Button
                        disabled={pending}
                        onClick={() => void remove(group)}
                        type="button"
                        variant="danger"
                      >
                        <Trash2 size={15} /> 删除
                      </Button>
                    </footer>
                  ) : null}
                </article>
              ),
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function RunnerMemberPicker({
  runners,
  selectedRunnerIds,
}: {
  runners: Runner[];
  selectedRunnerIds: readonly string[];
}) {
  const states: Record<string, string> = {
    online: "在线",
    offline: "离线",
    draining: "排空中",
    disabled: "已禁用",
  };
  const availableIds = new Set(runners.map((runner) => runner.id));
  const memberOptions = [
    ...runners.map((runner) => ({
      value: runner.id,
      label: runner.name,
      description: `${states[runner.state] ?? "不可用"} · ${runner.busySlots}/${runner.maxConcurrency} 槽位 · ${runner.labels.join("、")}`,
    })),
    ...selectedRunnerIds
      .filter((id) => !availableIds.has(id))
      .map((id) => ({
        value: id,
        label: `已有成员 · ${id}`,
        description: "当前候选中不可用；保留原绑定，取消勾选后才会移除。",
      })),
  ];
  return (
    <div>
      <CheckboxGroup
        label="组成员（可为空）"
        name="runnerIds"
        defaultValue={selectedRunnerIds}
        options={memberOptions}
      />
      <p className={cn("settings-note", uiPatterns["settings-note"])}>
        每组最多 64 台。搜索仅筛选候选，已选成员会保留。
      </p>
    </div>
  );
}

async function requestJson<T = unknown>(
  path: string,
  input?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    method: input?.method ?? "GET",
    ...(input?.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) }),
  });
  if (response.status === 204) return undefined as T;
  if (!response.ok) await throwApiErrorResponse(response, "执行机组操作失败。");
  return (await response.json()) as T;
}

function compareGroups(left: RunnerGroup, right: RunnerGroup): number {
  return left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id);
}

const runnerGroupManagerStyles = {
  "action-dialog-form": "mt-0",
  dot: "inline-block w-[7px] h-[7px] rounded-full",
  "gray-dot": "bg-border",
  "green-dot": "bg-success",
  "runner-group-actions": "flex gap-[7px] mt-auto",
  "runner-group-card":
    "flex min-w-0 flex-col border border-solid border-border rounded-lg p-[13px] bg-muted [&_>_header]:grid [&_>_header]:grid-cols-[auto_minmax(0,_1fr)_auto] [&_>_header]:items-center [&_>_header]:gap-[9px] [&_>_header_>_span:nth-child(2)]:flex [&_>_header_>_span:nth-child(2)]:min-w-0 [&_>_header_>_span:nth-child(2)]:flex-col [&_>_header_>_span:nth-child(2)]:gap-0.5 [&_>_header_strong]:[overflow-wrap:anywhere] [&_>_header_strong]:whitespace-normal [&_>_header_strong]:text-sm [&_>_header_small]:[overflow-wrap:anywhere] [&_>_header_small]:whitespace-normal [&_>_header_small]:text-muted-foreground [&_>_header_small]:text-xs [&_>_header_b]:rounded-full [&_>_header_b]:py-1 [&_>_header_b]:px-[7px] [&_>_header_b]:bg-card [&_>_header_b]:text-muted-foreground [&_>_header_b]:text-xs",
  "runner-group-description": "min-w-0",
  "runner-group-fields": "grid grid-cols-[minmax(220px,_0.6fr)_minmax(0,_1.4fr)] gap-3",
  "runner-group-grid": "grid grid-cols-3 gap-3 p-4 max-[1440px]:grid-cols-2",
  "runner-group-icon":
    "inline-grid w-[35px] h-[35px] place-items-center rounded-lg bg-info/10 text-info",
  "runner-group-list-card": "overflow-hidden",
  "runner-group-manager": "grid gap-3.5",
  "runner-group-members":
    "flex min-h-14.5 flex-wrap [align-content:flex-start] gap-1.5 my-3 mx-0 [&_>_span:not(.muted)]:inline-flex [&_>_span:not(.muted)]:items-center [&_>_span:not(.muted)]:gap-[5px] [&_>_span:not(.muted)]:max-w-full [&_>_span:not(.muted)]:border [&_>_span:not(.muted)]:border-solid [&_>_span:not(.muted)]:border-border [&_>_span:not(.muted)]:rounded-full [&_>_span:not(.muted)]:py-1 [&_>_span:not(.muted)]:px-[7px] [&_>_span:not(.muted)]:bg-card [&_>_span:not(.muted)]:text-xs [&_.dot]:w-1.5 [&_.dot]:h-1.5 [&_.dot]:m-0",
  "runner-group-toolbar": "flex items-center justify-between gap-3 text-muted-foreground text-sm",
  "table-count": "text-muted-foreground text-xs whitespace-nowrap",
} as const;
