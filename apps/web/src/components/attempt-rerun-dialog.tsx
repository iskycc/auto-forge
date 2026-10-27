"use client";

import { Alert, Input, Spin, type InputRef } from "antd";
import {
  caseLogRerunConfigurationSchema,
  rerunCaseFromAttemptInputSchema,
  type CaseLogRerunConfiguration,
  type RerunCaseFromAttemptInput,
} from "@autoforge/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

export function AttemptRerunDialog({
  attemptId,
  pending,
  onClose,
  onConfirm,
}: {
  attemptId: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (input: RerunCaseFromAttemptInput) => Promise<void>;
}) {
  const formId = useId();
  const inputRef = useRef<InputRef>(null);
  const inFlight = useRef(false);
  const [configuration, setConfiguration] = useState<CaseLogRerunConfiguration>();
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [environmentIp, setEnvironmentIp] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    async function loadConfiguration() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/v1/run-attempts/${encodeURIComponent(attemptId)}/rerun`,
          {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          },
        );
        if (!response.ok)
          throw new Error((await readApiErrorMessage(response, "读取重跑环境失败。"))!);
        const next = caseLogRerunConfigurationSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setConfiguration(next);
        setEnvironmentIp(next.environmentIp ?? "");
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取重跑环境失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadConfiguration();
    return () => controller.abort();
  }, [attemptId, loadAttempt]);

  async function submit() {
    if (inFlight.current || loading || !configuration) return;
    const parsed = rerunCaseFromAttemptInputSchema.safeParse(editing ? { environmentIp } : {});
    if (!parsed.success) {
      setError("请输入有效的 IPv4 或 IPv6 地址。");
      inputRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setError("");
    try {
      await onConfirm(parsed.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "执行此用例失败。");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <ActionDialog
      open
      title="执行此用例"
      description="确认本次重跑的环境 IP，其他设置沿用原执行任务。"
      className="w-[min(520px,calc(100dvw-3rem))]"
      closeDisabled={pending}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={
              loading ||
              !configuration ||
              pending ||
              (!editing && configuration.adapterEnabled && !configuration.environmentIp)
            }
          >
            {pending ? "正在提交…" : "确认执行"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {loading ? (
          <div className="flex min-h-24 items-center justify-center gap-2 text-muted-foreground">
            <Spin size="small" />
            正在读取重跑环境…
          </div>
        ) : configuration ? (
          <>
            <label className="grid gap-2" htmlFor={`${formId}-ip`}>
              <span className="font-medium">本次重跑环境 IP</span>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  ref={inputRef}
                  id={`${formId}-ip`}
                  aria-label="本次重跑环境 IP"
                  autoComplete="off"
                  readOnly={!editing}
                  disabled={pending || !configuration.adapterEnabled}
                  value={environmentIp}
                  placeholder={
                    configuration.adapterEnabled
                      ? "请输入 IPv4 或 IPv6 地址"
                      : "原执行未启用 Adapter"
                  }
                  onChange={(event) => {
                    setEnvironmentIp(event.target.value);
                    setError("");
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending || !configuration.adapterEnabled}
                  className="shrink-0"
                  onClick={() => {
                    setError("");
                    if (editing) setEnvironmentIp(configuration.environmentIp ?? "");
                    setEditing(!editing);
                    if (!editing)
                      requestAnimationFrame(() => inputRef.current?.focus({ cursor: "all" }));
                  }}
                >
                  {editing ? "恢复原 IP" : "修改"}
                </Button>
              </div>
            </label>
            <p className="m-0 text-sm leading-6 text-muted-foreground">
              {configuration.adapterEnabled
                ? configuration.environmentIp
                  ? "修改仅对本次重跑生效，不改变任务配置；下次重跑仍使用原环境 IP。"
                  : "原执行未记录环境 IP，请点击修改并填写本次重跑地址。"
                : "原执行未启用 Adapter，本次按原配置执行。"}
            </p>
          </>
        ) : null}
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {!loading && !configuration ? (
          <Button type="button" onClick={() => setLoadAttempt((current) => current + 1)}>
            重试加载
          </Button>
        ) : null}
      </form>
    </ActionDialog>
  );
}
