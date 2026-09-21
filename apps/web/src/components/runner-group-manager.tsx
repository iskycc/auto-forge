"use client";

import type { Runner, RunnerGroup } from "@autoforge/domain";
import { LoaderCircle, Pencil, Plus, Server, Trash2, UsersRound, X } from "lucide-react";
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
    <div className="runner-group-manager">
      {canManage ? (
        <div className="runner-group-toolbar">
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
        <form className="action-dialog-form" onSubmit={(event) => void create(event)}>
          <div className="runner-group-fields">
            <label className="field-stack">
              <span>组名称</span>
              <Input maxLength={120} name="name" required />
            </label>
            <label className="field-stack runner-group-description">
              <span>说明</span>
              <Textarea maxLength={500} name="description" rows={2} />
            </label>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <RunnerMemberPicker runners={runners} selectedRunnerIds={[]} />
          <Button disabled={pending} type="submit" variant="primary">
            {pending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
            创建执行机组
          </Button>
        </form>
      </ActionDialog>

      {error && !createOpen && !editingGroupId ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="card runner-group-list-card">
        <div className="section-title-row">
          <div>
            <span className="eyebrow">RESOURCE POOLS</span>
            <h2>执行机组</h2>
          </div>
          <span className="table-count">共 {groups.length} 组</span>
        </div>
        {groups.length === 0 ? (
          <div className="empty-state table-empty">
            <span className="empty-icon">
              <UsersRound size={25} />
            </span>
            <strong>尚未创建执行机组</strong>
            <p>创建后，发起任务批跑和单用例执行时都可以直接选择整组资源。</p>
          </div>
        ) : (
          <div className="runner-group-grid">
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
                    className="action-dialog-form"
                    onSubmit={(event) => void update(group, event)}
                  >
                    <div className="runner-group-fields">
                      <label className="field-stack">
                        <span>组名称</span>
                        <Input defaultValue={group.name} maxLength={120} name="name" required />
                      </label>
                      <label className="field-stack runner-group-description">
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
                      <p className="form-error" role="alert">
                        {error}
                      </p>
                    ) : null}
                    <RunnerMemberPicker runners={runners} selectedRunnerIds={group.runnerIds} />
                    <div className="runner-group-actions">
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
                <article className="runner-group-card" key={group.id}>
                  <header>
                    <span className="runner-group-icon">
                      <UsersRound size={19} />
                    </span>
                    <span>
                      <strong>{group.name}</strong>
                      <small>{group.description || "未填写说明"}</small>
                    </span>
                    <b>{group.runnerIds.length} 台</b>
                  </header>
                  <div className="runner-group-members">
                    {group.runnerIds.length === 0 ? (
                      <span className="muted">当前没有成员</span>
                    ) : (
                      group.runnerIds.map((runnerId) => {
                        const runner = runners.find((candidate) => candidate.id === runnerId);
                        return (
                          <span key={runnerId}>
                            <Server size={14} /> {runner?.name ?? runnerId}
                            <i
                              className={`dot ${runner?.state === "online" ? "green-dot" : "gray-dot"}`}
                            />
                          </span>
                        );
                      })
                    )}
                  </div>
                  {canManage ? (
                    <footer className="runner-group-actions">
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
      </section>
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
      <p className="settings-note">每组最多 64 台。搜索仅筛选候选，已选成员会保留。</p>
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
