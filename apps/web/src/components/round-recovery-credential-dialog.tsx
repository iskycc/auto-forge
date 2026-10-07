"use client";

import { useEffect, useRef, useState } from "react";
import {
  roundRecoveryCredentialSourcesPageSchema,
  type RoundRecoveryCredentialSource,
} from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { Button, Input } from "./ui";
import { Notice } from "./ui/notice";
import { EmptyState } from "./ui/empty-state";
import { Segmented } from "./ui/segmented";
import { readApiErrorMessage } from "@/lib/client-api";
import type { RoundRecoveryCredentialChoice } from "@/lib/round-recovery-credential-input";

export function RoundRecoveryCredentialDialog({
  suiteId,
  localChoices,
  onSelect,
  onClose,
}: {
  suiteId: string;
  localChoices: RoundRecoveryCredentialChoice[];
  onSelect: (choice: RoundRecoveryCredentialChoice) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"current" | "other">("current");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [sources, setSources] = useState<RoundRecoveryCredentialSource[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function search(nextCursor?: string): Promise<void> {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setError("");
    try {
      const parameters = new URLSearchParams({ query: nextCursor ? submittedQuery : query });
      if (nextCursor) parameters.set("cursor", nextCursor);
      const response = await fetch(
        `/api/v1/case-suites/${encodeURIComponent(suiteId)}/round-recovery/credentials?${parameters}`,
        { cache: "no-store", signal: request.signal },
      );
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "读取可复用密钥失败。"))!);
      const page = roundRecoveryCredentialSourcesPageSchema.parse(await response.json());
      if (request.signal.aborted) return;
      setSources(page.items);
      setCursor(page.nextCursor);
      setSubmittedQuery(nextCursor ? submittedQuery : query);
    } catch (cause) {
      if (!request.signal.aborted)
        setError(cause instanceof Error ? cause.message : "读取可复用密钥失败。");
    } finally {
      if (controller.current === request) setPending(false);
    }
  }

  const choices =
    scope === "current"
      ? localChoices
      : sources.map((source) => ({
          suiteId: source.suiteId,
          ruleId: source.ruleId,
          label: `${source.suiteName} · 第 ${source.afterRound} 轮后 · ${source.jenkinsJobUrl}`,
        }));

  return (
    <ActionDialog
      open
      title="复用 Jenkins 密钥"
      description="选择本任务的其他恢复步骤，或有管理权限的其他任务。保存后目标步骤独立加密，来源密钥不会回显。"
      className="w-[min(640px,_calc(100dvw_-_40px))]"
      onClose={onClose}
      footer={
        <Button type="button" variant="secondary" onClick={onClose}>
          取消
        </Button>
      }
    >
      <div className="grid min-w-0 gap-4">
        <Segmented
          label="密钥来源范围"
          value={scope}
          options={[
            { value: "current", label: "本任务" },
            { value: "other", label: "其他任务" },
          ]}
          onChange={(value) => {
            setScope(value);
            if (value === "other") void search();
          }}
        />
        {scope === "other" ? (
          <div className="flex min-w-0 gap-2">
            <Input
              aria-label="查找密钥来源任务"
              maxLength={120}
              value={query}
              placeholder="按任务名称或 Jenkins 任务链接查找"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void search();
                }
              }}
            />
            <Button type="button" disabled={pending} onClick={() => void search()}>
              {pending ? "查询中…" : "查询"}
            </Button>
          </div>
        ) : null}
        {error ? (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        ) : null}
        <div className="grid max-h-72 min-w-0 gap-2 overflow-y-auto">
          {choices.map((choice) => (
            <Button
              key={`${choice.suiteId}:${choice.ruleId}`}
              type="button"
              variant="secondary"
              className="h-auto! min-w-0 justify-start! whitespace-normal! py-3! text-left!"
              onClick={() => onSelect(choice)}
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{choice.label}</span>
            </Button>
          ))}
          {!pending && choices.length === 0 ? (
            <EmptyState>
              {scope === "current"
                ? "本任务暂无其他可复用的密钥，请先为一个恢复步骤填写或保存密钥。"
                : "未找到可复用密钥，可调整查询条件。"}
            </EmptyState>
          ) : null}
        </div>
        {scope === "other" && cursor ? (
          <Button type="button" disabled={pending} onClick={() => void search(cursor)}>
            下一页
          </Button>
        ) : null}
        <p className="m-0 text-sm text-muted-foreground">
          复用适用于同一 Jenkins 服务地址下的不同 Job。不同服务地址请单独输入密钥。
        </p>
      </div>
    </ActionDialog>
  );
}
