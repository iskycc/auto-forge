"use client";

import { Alert } from "antd";
import { RotateCcw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  caseLogRerunConfigurationSchema,
  type CaseLogRerunConfiguration,
  type RerunCaseFromAttemptInput,
} from "@autoforge/contracts";

import { readApiErrorMessage } from "@/lib/client-api";
import { AttemptRerunDialog } from "./attempt-rerun-dialog";
import { Button } from "./ui/button";

/** Page state intentionally survives execution/history refreshes, but not a document reload. */
export function AttemptRerunEnvironment({
  attemptId,
  pending,
  onRerun,
}: {
  attemptId: string;
  pending: boolean;
  onRerun: (input: RerunCaseFromAttemptInput) => Promise<void>;
}) {
  const [configuration, setConfiguration] = useState<CaseLogRerunConfiguration>();
  const [environmentOverride, setEnvironmentOverride] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const submitting = useRef(false);
  const environmentIp = environmentOverride ?? configuration?.environmentIp;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
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
        const result = caseLogRerunConfigurationSchema.parse(await response.json());
        if (!controller.signal.aborted) setConfiguration(result);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取重跑环境失败。");
      }
    }
    void load();
    return () => controller.abort();
  }, [attemptId, loadAttempt]);

  async function execute() {
    if (submitting.current || pending || !configuration) return;
    submitting.current = true;
    setError("");
    try {
      await onRerun(
        environmentOverride === undefined ? {} : { environmentIp: environmentOverride },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "执行此用例失败。");
    } finally {
      submitting.current = false;
    }
  }

  return (
    <section className="grid min-w-0 max-w-full gap-2" aria-label="手动执行环境">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          aria-label="执行此用例"
          aria-busy={pending}
          disabled={pending || !configuration || (configuration.adapterEnabled && !environmentIp)}
          onClick={() => void execute()}
        >
          <RotateCcw size={15} />
          {pending ? "正在提交…" : "执行此用例"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || !configuration?.adapterEnabled}
          onClick={() => setEditing(true)}
        >
          <Settings2 size={15} />
          设置重跑环境 IP
        </Button>
      </div>
      <div className="flex min-w-0 max-w-xl flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted px-3 py-2 text-xs">
        <span className="text-muted-foreground">下一次手动执行 IP</span>
        <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
          {configuration
            ? configuration.adapterEnabled
              ? environmentIp || "尚未配置"
              : "未启用 Adapter"
            : error
              ? "读取失败"
              : "正在读取…"}
        </span>
        {configuration?.adapterEnabled ? (
          <span className="text-muted-foreground">
            · {environmentOverride === undefined ? "本次执行环境" : "本页自定义"}
          </span>
        ) : null}
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            !configuration ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError("");
                  setLoadAttempt((current) => current + 1);
                }}
              >
                重试加载
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {editing && configuration ? (
        <AttemptRerunDialog
          attemptId={attemptId}
          pending={pending}
          settings={{
            configuration,
            ...(environmentOverride === undefined ? {} : { environmentIp: environmentOverride }),
          }}
          onClose={() => setEditing(false)}
          onConfirm={async (input) => {
            setEnvironmentOverride(input.environmentIp);
            setEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}
