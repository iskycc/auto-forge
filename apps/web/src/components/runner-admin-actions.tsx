"use client";

import { Button } from "@/components/ui";

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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function post(path: string, confirmation: string) {
    if (!window.confirm(confirmation)) return;
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
    if (!window.confirm(confirmation)) return;
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

  if (deregistered) {
    return <span className="muted">已注销</span>;
  }

  return (
    <span className="runner-admin-actions">
      {state === "draining" || state === "disabled" ? (
        <Button
          className="text-button"
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
          className="text-button"
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
          className="danger-text-button"
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
        <small className="muted">凭据已撤销</small>
      ) : (
        <>
          <Button
            className="text-button"
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
            className="danger-text-button"
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
        className="danger-text-button"
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
        <small className="form-error" role="alert">
          {error}
        </small>
      ) : null}
    </span>
  );
}
