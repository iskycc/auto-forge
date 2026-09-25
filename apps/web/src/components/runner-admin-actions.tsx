"use client";
import { Notice } from "@/components/ui/notice";

import { Disclosure } from "@/components/ui/disclosure";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button } from "@/components/ui";
import { useConfirm } from "@/components/ui-feedback";

import { useRouter } from "next/navigation";
import { useState } from "react";

type RunnerAdminActionsProps = {
  runnerId: string;
  runnerName: string;
  credentialRevoked: boolean;
  credentialRotationRequested: boolean;
  deregistered: boolean;
  state: "online" | "offline" | "draining" | "disabled";
};

export function RunnerAdminActions({
  runnerId,
  runnerName,
  credentialRevoked,
  credentialRotationRequested,
  deregistered,
  state,
}: RunnerAdminActionsProps) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function post(path: string, confirmation: string) {
    if (
      !(await confirmAction({
        title: "确认执行机操作",
        description: confirmation,
        confirmLabel: "确认操作",
        tone: "danger",
      }))
    )
      return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(path, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? "操作失败。");
      }
      setPending(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
      setPending(false);
    }
  }

  async function setLifecycleState(
    nextState: "active" | "draining" | "disabled",
    confirmation: string,
  ) {
    if (
      !(await confirmAction({
        title: "变更执行机状态",
        description: confirmation,
        confirmLabel: "确认变更",
        tone: nextState === "active" ? "default" : "danger",
      }))
    )
      return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/runners/${encodeURIComponent(runnerId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: nextState }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? "更新执行机状态失败。");
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "更新执行机状态失败。");
    } finally {
      setPending(false);
    }
  }

  async function remove(confirmation: string) {
    if (
      !(await confirmAction({
        title: "删除执行机记录",
        description: confirmation,
        confirmLabel: "确认删除",
        tone: "danger",
      }))
    )
      return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/runners/${encodeURIComponent(runnerId)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? "删除执行机记录失败。");
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除执行机记录失败。");
    } finally {
      setPending(false);
    }
  }

  if (deregistered) {
    return (
      <Disclosure
        header={<>管理操作</>}
        className={cn("runner-actions-menu", runnerAdminActionsStyles["runner-actions-menu"])}
      >
        <div
          className={cn("runner-admin-actions", runnerAdminActionsStyles["runner-admin-actions"])}
        >
          <span className={cn("muted", uiPatterns["muted"])}>已注销</span>
          <Button
            className={cn("danger-text-button", uiPatterns["danger-text-button"])}
            disabled={pending}
            onClick={() =>
              void remove(
                `确定删除已注销执行机「${runnerName}」的平台记录？执行历史保留，删除后无法恢复。`,
              )
            }
            type="button"
          >
            删除
          </Button>
          {error ? (
            <Notice
              tone="error"
              className={cn("form-error", uiPatterns["form-error"])}
              role="alert"
            >
              {error}
            </Notice>
          ) : null}
        </div>
      </Disclosure>
    );
  }

  return (
    <Disclosure
      header={<>管理操作</>}
      className={cn("runner-actions-menu", runnerAdminActionsStyles["runner-actions-menu"])}
    >
      <div className={cn("runner-admin-actions", runnerAdminActionsStyles["runner-admin-actions"])}>
        {state === "draining" || state === "disabled" ? (
          <Button
            className={cn("text-button", uiPatterns["text-button"])}
            disabled={pending || credentialRevoked}
            onClick={() =>
              void setLifecycleState("active", `确定让执行机「${runnerName}」恢复领取新任务？`)
            }
            type="button"
          >
            恢复接单
          </Button>
        ) : (
          <Button
            className={cn("text-button", uiPatterns["text-button"])}
            disabled={pending || credentialRevoked}
            onClick={() =>
              void setLifecycleState(
                "draining",
                `确定排空执行机「${runnerName}」？当前任务继续运行，但不会领取新任务。`,
              )
            }
            type="button"
          >
            排空
          </Button>
        )}
        {state !== "disabled" ? (
          <Button
            className={cn("danger-text-button", uiPatterns["danger-text-button"])}
            disabled={pending}
            onClick={() =>
              void setLifecycleState(
                "disabled",
                `确定禁用执行机「${runnerName}」？Agent 将无法继续调用控制面。`,
              )
            }
            type="button"
          >
            禁用
          </Button>
        ) : null}
        {credentialRevoked ? (
          <small className={cn("muted", uiPatterns["muted"])}>凭据已撤销</small>
        ) : (
          <>
            <Button
              className={cn("text-button", uiPatterns["text-button"])}
              disabled={pending || credentialRotationRequested}
              onClick={() =>
                void post(
                  `/api/v1/runners/${runnerId}/credential/rotate`,
                  `确定请求执行机「${runnerName}」轮换凭据？Agent 将在下一次心跳安全保存新凭据。`,
                )
              }
              type="button"
            >
              {credentialRotationRequested ? "等待轮换" : "轮换凭据"}
            </Button>
            <Button
              className={cn("danger-text-button", uiPatterns["danger-text-button"])}
              disabled={pending}
              onClick={() =>
                void post(
                  `/api/v1/runners/${runnerId}/credential/revoke`,
                  `确定撤销执行机「${runnerName}」的凭据？撤销后 Agent 将无法继续连接控制面，需要重新注册。`,
                )
              }
              type="button"
            >
              撤销凭据
            </Button>
          </>
        )}
        <Button
          className={cn("danger-text-button", uiPatterns["danger-text-button"])}
          disabled={pending}
          onClick={() =>
            void post(
              `/api/v1/runners/${runnerId}/deregister`,
              `确定注销执行机「${runnerName}」？其活跃执行任务将立即重新排队，该执行机无法再次连接控制面。`,
            )
          }
          type="button"
        >
          注销
        </Button>
        {error ? (
          <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
            {error}
          </Notice>
        ) : null}
      </div>
    </Disclosure>
  );
}

const runnerAdminActionsStyles = {
  "runner-actions-menu":
    "relative [&_.ui-disclosure-label]:min-h-9 [&_.ui-disclosure-label]:inline-flex [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:border [&_.ui-disclosure-label]:border-solid [&_.ui-disclosure-label]:border-border [&_.ui-disclosure-label]:rounded-lg [&_.ui-disclosure-label]:py-0 [&_.ui-disclosure-label]:px-[13px] [&_.ui-disclosure-label]:bg-card [&_.ui-disclosure-label]:text-foreground [&_.ui-disclosure-label]:shadow-xs [&_.ui-disclosure-label]:text-sm [&_.ui-disclosure-label]:font-semibold [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:[list-style:none] [&_.ui-disclosure-label::-webkit-details-marker]:hidden [&[data-open=true]_.ui-disclosure-label]:bg-accent [&_.ui-disclosure-body_>_.runner-admin-actions]:absolute [&_.ui-disclosure-body_>_.runner-admin-actions]:z-20 [&_.ui-disclosure-body_>_.runner-admin-actions]:right-0 [&_.ui-disclosure-body_>_.runner-admin-actions]:bottom-[calc(100%_+_8px)] [&_.ui-disclosure-body_>_.runner-admin-actions]:w-max [&_.ui-disclosure-body_>_.runner-admin-actions]:min-w-[180px] [&_.ui-disclosure-body_>_.runner-admin-actions]:p-2.5 [&_.ui-disclosure-body_>_.runner-admin-actions]:border [&_.ui-disclosure-body_>_.runner-admin-actions]:border-solid [&_.ui-disclosure-body_>_.runner-admin-actions]:border-border [&_.ui-disclosure-body_>_.runner-admin-actions]:rounded-xl [&_.ui-disclosure-body_>_.runner-admin-actions]:bg-card [&_.ui-disclosure-body_>_.runner-admin-actions]:shadow-xs [&_.ui-button]:w-full",
  "runner-admin-actions": "flex items-stretch flex-col gap-2.5",
} as const;
