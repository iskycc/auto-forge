"use client";

import { useEffect, useRef, useState } from "react";
import { Descriptions, Progress } from "antd";
import {
  ddtScopeClearPageSchema,
  ddtScopeClearPreviewSchema,
  type DdtScopeClearPreview,
} from "@autoforge/contracts";
import type { DdtScope } from "@autoforge/domain";
import { ActionDialog } from "./action-dialog";
import { Button, Input } from "./ui";
import { Notice } from "./ui/notice";
import { LoadingStateMessage } from "./ui/loading-state-message";
import { readApiErrorMessage } from "@/lib/client-api";

const confirmationText = "清空DDT用例";
const emptyProgress = { removedMembers: 0, deletedHistory: 0, deletedCases: 0, deletedRecycled: 0 };
const phaseLabels = {
  tasks: "正在从任务中移除 DDT 成员",
  history: "正在清理修改历史",
  cases: "正在删除 DDT 用例",
  recycle: "正在清空 DDT 回收站",
  done: "清空完成",
};

export function DdtScopeClearDialog({
  scope,
  scopeLabel,
  onClose,
  onChanged,
}: {
  scope: DdtScope;
  scopeLabel: string;
  onClose(): void;
  onChanged(): Promise<void>;
}) {
  const endpoint = `/api/v1/ddt/clear?${new URLSearchParams(scope)}`;
  const [preview, setPreview] = useState<DdtScopeClearPreview>();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [progress, setProgress] = useState(emptyProgress);
  const [phase, setPhase] = useState<keyof typeof phaseLabels>("tasks");
  const request = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, "读取清空范围失败。"));
        const result = ddtScopeClearPreviewSchema.parse(await response.json());
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取清空范围失败。");
      });
    return () => controller.abort();
  }, [endpoint, reload]);
  useEffect(() => () => request.current?.abort(), []);

  async function clear() {
    if (!preview || busy || confirmation !== confirmationText) return;
    const controller = new AbortController();
    request.current = controller;
    stopRequested.current = false;
    setBusy(true);
    setError("");
    try {
      for (;;) {
        const response = await fetch(endpoint, {
          method: "DELETE",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clearedBefore: preview.clearedBefore,
            confirmation: confirmationText,
          }),
        });
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, "清空 DDT 用例失败。"));
        const page = ddtScopeClearPageSchema.parse(await response.json());
        controller.signal.throwIfAborted();
        setPhase(page.phase);
        setProgress((current) => ({
          removedMembers: current.removedMembers + page.removedMembers,
          deletedHistory: current.deletedHistory + page.deletedHistory,
          deletedCases: current.deletedCases + page.deletedCases,
          deletedRecycled: current.deletedRecycled + page.deletedRecycled,
        }));
        if (!page.hasMore) {
          setDone(true);
          break;
        }
        if (stopRequested.current) break;
        if (
          !page.removedMembers &&
          !page.deletedHistory &&
          !page.deletedCases &&
          !page.deletedRecycled
        )
          throw new Error("清理未取得进展，请稍后继续。");
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "清空失败，可继续处理剩余数据。");
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        try {
          await onChanged();
        } catch {
          setError("清理结果已保存，页面刷新失败，请手动刷新。");
        }
      }
      request.current = null;
    }
  }

  const total = preview ? preview.activeCases + preview.recycledCases + preview.suiteMembers : 0;
  const processed = progress.removedMembers + progress.deletedCases + progress.deletedRecycled;
  return (
    <ActionDialog
      open
      title="清空当前范围 DDT 用例"
      closeDisabled={busy}
      onClose={onClose}
      description={scopeLabel}
      footer={
        <>
          {busy ? (
            <Button
              onClick={() => {
                stopRequested.current = true;
              }}
            >
              停止清理
            </Button>
          ) : (
            <Button onClick={onClose}>{done ? "完成" : "取消"}</Button>
          )}
          {!done ? (
            <Button
              variant="danger"
              loading={busy}
              disabled={!preview || confirmation !== confirmationText || busy}
              onClick={() => void clear()}
            >
              {processed || progress.deletedHistory ? "继续清空" : "确认永久清空"}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid min-w-0 gap-4">
        <Notice tone="warning">
          永久删除当前项目、版本、测试阶段的 DDT
          用例、回收站记录及修改历史，并从任务中移除这些用例。任务、普通 TestNG
          用例和已有执行记录保留。此操作无法恢复。
        </Notice>
        {!preview && !error ? <LoadingStateMessage>正在核对清空范围…</LoadingStateMessage> : null}
        {preview ? (
          <>
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: "cases", label: "活动 DDT 用例", children: preview.activeCases },
                { key: "recycle", label: "回收站记录", children: preview.recycledCases },
                { key: "suites", label: "关联任务", children: preview.affectedSuites },
                { key: "members", label: "需移除任务成员", children: preview.suiteMembers },
              ]}
            />
            <label className="grid gap-2 text-sm">
              <span>输入「{confirmationText}」确认</span>
              <Input
                aria-label="清空确认文字"
                placeholder={confirmationText}
                value={confirmation}
                disabled={busy || done}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            {busy || done || processed || progress.deletedHistory ? (
              <div role="status" className="grid gap-2 text-sm">
                <strong>
                  {done ? "清空完成" : busy ? phaseLabels[phase] : "清理已停止，可继续处理剩余数据"}
                </strong>
                <Progress
                  percent={
                    done ? 100 : total ? Math.min(99, Math.floor((processed / total) * 100)) : 0
                  }
                  status={error ? "exception" : done ? "success" : "active"}
                />
                <span>
                  已删除用例 {progress.deletedCases} 条 · 回收站 {progress.deletedRecycled} 条 ·
                  修改历史 {progress.deletedHistory} 条 · 移除任务成员 {progress.removedMembers} 个
                </span>
              </div>
            ) : null}
            <p className="m-0 text-xs text-muted-foreground">
              仅处理确认范围时已存在且此后未更新的数据；执行期间新增或更新的用例会保留。中途停止后，已经完成的清理不会回退。重新导入会生成新用例记录，旧执行可从执行记录页面查看。
            </p>
          </>
        ) : null}
        {error ? (
          <Notice tone="error">
            {error}
            {!preview ? (
              <Button
                onClick={() => {
                  setError("");
                  setReload((current) => current + 1);
                }}
              >
                重新核对范围
              </Button>
            ) : null}
          </Notice>
        ) : null}
      </div>
    </ActionDialog>
  );
}
