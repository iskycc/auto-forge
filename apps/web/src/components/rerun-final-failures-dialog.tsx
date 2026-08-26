"use client";

import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { Button, Input } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

export function RerunFinalFailuresDialog({
  batchId,
  defaultConcurrency,
  failedCount,
  hasRetryConcurrencyRules,
  hasRoundRecovery,
  onClose,
  onCreated,
}: {
  batchId: string;
  defaultConcurrency: number;
  failedCount: number;
  hasRetryConcurrencyRules: boolean;
  hasRoundRecovery: boolean;
  onClose: () => void;
  onCreated: (batchId: string) => void;
}) {
  const [concurrency, setConcurrency] = useState(String(defaultConcurrency));
  const [enableRetryConcurrencyRules, setEnableRetryConcurrencyRules] = useState(true);
  const [enableRoundRecovery, setEnableRoundRecovery] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(): Promise<void> {
    const parsedConcurrency = Number(concurrency);
    if (
      !Number.isInteger(parsedConcurrency) ||
      parsedConcurrency < 1 ||
      parsedConcurrency > 10_000
    ) {
      setError("并发数必须是 1 到 10000 之间的整数。");
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/run-batches/${encodeURIComponent(batchId)}/rerun-final-failures`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            concurrency: parsedConcurrency,
            enableRetryConcurrencyRules,
            enableRoundRecovery,
          }),
        },
      );
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "重新执行最后失败用例失败。"))!);
      }
      const created = (await response.json()) as { id?: string };
      if (!created.id) throw new Error("平台未返回新批次标识。");
      onCreated(created.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "重新执行最后失败用例失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <ActionDialog
      className="rerun-failures-dialog"
      description={`仅使用当前批次最后仍失败或超时的 ${failedCount} 个用例，其他执行配置来自原批次快照。`}
      onClose={pending ? () => undefined : onClose}
      open
      title="重新执行最后一轮"
    >
      <div className="rerun-failures-form">
        <label className="field">
          <span>本次并发数</span>
          <Input
            aria-label="本次并发数"
            disabled={pending}
            max={10_000}
            min={1}
            onChange={(event) => setConcurrency(event.target.value)}
            type="number"
            value={concurrency}
          />
          <small>只覆盖新批次的基础并发，不修改原任务。</small>
        </label>
        {hasRetryConcurrencyRules ? (
          <label className="checkbox-field rerun-option">
            <Input
              checked={enableRetryConcurrencyRules}
              disabled={pending}
              onChange={(event) => setEnableRetryConcurrencyRules(event.target.checked)}
              type="checkbox"
            />
            <span>
              启用动态并发规则
              <small>关闭后，本次执行始终使用上方并发数。</small>
            </span>
          </label>
        ) : null}
        {hasRoundRecovery ? (
          <label className="checkbox-field rerun-option">
            <Input
              checked={enableRoundRecovery}
              disabled={pending}
              onChange={(event) => setEnableRoundRecovery(event.target.checked)}
              type="checkbox"
            />
            <span>
              启用 Jenkins 环境恢复
              <small>关闭后，本次轮次之间不触发环境清理流水线。</small>
            </span>
          </label>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="action-dialog-actions">
          <Button disabled={pending} onClick={onClose} type="button" variant="secondary">
            取消
          </Button>
          <Button disabled={pending} onClick={() => void submit()} type="button" variant="primary">
            <RotateCcw size={16} />
            {pending ? "正在创建…" : `执行 ${failedCount} 个用例`}
          </Button>
        </div>
      </div>
    </ActionDialog>
  );
}
