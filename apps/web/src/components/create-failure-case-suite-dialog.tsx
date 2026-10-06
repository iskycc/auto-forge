"use client";

import type { RunBatchPreflightResult } from "@autoforge/contracts";
import { ListPlus, Play } from "lucide-react";
import { useRef, useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Input } from "@/components/ui";
import { Notice } from "@/components/ui/notice";
import { readApiErrorMessage } from "@/lib/client-api";

export function CreateFailureCaseSuiteDialog({
  batchId,
  suiteName,
  failedCount,
  canCreateRuns,
  onClose,
  onCreated,
  onStarted,
}: {
  batchId: string;
  suiteName: string;
  failedCount: number;
  canCreateRuns: boolean;
  onClose: () => void;
  onCreated: (suiteId: string) => void;
  onStarted: (batchId: string) => void;
}) {
  const suffix = " · 失败用例";
  const [name, setName] = useState(`${suiteName.slice(0, 120 - suffix.length)}${suffix}`);
  const [pendingAction, setPendingAction] = useState<"create" | "execute">();
  const [createdSuiteId, setCreatedSuiteId] = useState<string>();
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const pending = pendingAction !== undefined;

  async function createTask(): Promise<string> {
    const response = await fetch(
      `/api/v1/run-batches/${encodeURIComponent(batchId)}/failure-case-suite`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      },
    );
    if (!response.ok)
      throw new Error((await readApiErrorMessage(response, "以失败用例创建任务失败。"))!);
    const suite = (await response.json()) as { id?: string };
    if (!suite.id) throw new Error("平台未返回新任务标识。");
    return suite.id;
  }

  async function startTask(suiteId: string): Promise<string> {
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suiteId, delaySeconds: 0 }),
    };
    const preflightResponse = await fetch("/api/v1/run-batches/preflight", request);
    if (!preflightResponse.ok)
      throw new Error((await readApiErrorMessage(preflightResponse, "执行配置预检失败。"))!);
    const preflight = (await preflightResponse.json()) as RunBatchPreflightResult;
    if (!preflight.ready)
      throw new Error(preflight.blockers.map((blocker) => blocker.message).join("；"));
    const response = await fetch("/api/v1/run-batches", request);
    if (!response.ok) throw new Error((await readApiErrorMessage(response, "立即执行任务失败。"))!);
    const batch = (await response.json()) as { id?: string };
    if (!batch.id) throw new Error("平台未返回新执行批次标识。");
    return batch.id;
  }

  async function submit(action: "create" | "execute"): Promise<void> {
    if (submitting.current || (action === "execute" && !canCreateRuns)) return;
    if (!name.trim()) {
      setError("请填写任务名称。");
      return;
    }
    submitting.current = true;
    setPendingAction(action);
    setError("");
    let suiteId = createdSuiteId;
    try {
      if (!suiteId) {
        suiteId = await createTask();
        setCreatedSuiteId(suiteId);
      }
      if (action === "create") onCreated(suiteId);
      else onStarted(await startTask(suiteId));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "以失败用例创建任务失败。";
      setError(suiteId ? `任务已创建，但立即执行失败：${message}` : message);
    } finally {
      submitting.current = false;
      setPendingAction(undefined);
    }
  }

  return (
    <ActionDialog
      open
      title="以失败用例创建任务"
      description={`将本次执行最终失败或超时的 ${failedCount} 个用例保存为独立任务，配置复制本次执行快照。`}
      className="w-[min(560px,_calc(100dvw_-_40px))]"
      closeDisabled={pending}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="create-failure-case-suite"
            variant="secondary"
            disabled={pending}
          >
            <ListPlus size={16} />
            {pendingAction === "create" ? "正在创建…" : createdSuiteId ? "查看任务" : "创建任务"}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={pending || !canCreateRuns}
            onClick={() => void submit("execute")}
          >
            <Play size={16} />
            {pendingAction === "execute"
              ? "正在创建并执行…"
              : createdSuiteId
                ? "重试执行"
                : "创建并立即执行"}
          </Button>
        </>
      }
    >
      <form
        id="create-failure-case-suite"
        className="grid min-w-0 gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit("create");
        }}
      >
        <label className="grid min-w-0 gap-2 text-sm font-semibold">
          <span>任务名称</span>
          <Input
            aria-label="任务名称"
            autoFocus
            maxLength={120}
            disabled={pending || !!createdSuiteId}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="grid min-w-0 gap-2 rounded-lg border border-border bg-muted/30 p-4 text-sm">
          <span className="text-muted-foreground">来源任务</span>
          <strong className="font-medium [overflow-wrap:anywhere]">{suiteName}</strong>
          <span className="text-muted-foreground">用例范围：最终失败或超时 {failedCount} 个</span>
        </div>
        <p className="m-0 text-sm leading-6 text-muted-foreground">
          选择“创建任务”进入新任务详情，或“创建并立即执行”直接启动并查看执行进度。执行计划和回调通知绑定按新任务单独配置。
        </p>
        {!canCreateRuns ? (
          <Notice tone="warning">当前账号没有此项目的执行权限，仍可创建任务。</Notice>
        ) : null}
        {error ? (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        ) : null}
      </form>
    </ActionDialog>
  );
}
