"use client";

import { Alert, Checkbox } from "antd";
import { Square } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";
import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui";
import { useToast } from "@/components/ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";
import { rememberManualStopWarning, skipManualStopWarning } from "@/lib/manual-stop-preference";

const browserStorage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
};
const stopResultSchema = z.object({ cancelled: z.boolean() });

export function ManualAttemptStopAction({
  attemptId,
  onCancelled,
}: {
  attemptId: string;
  onCancelled: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  async function stopExecution(rememberChoice: boolean): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/run-attempts/${encodeURIComponent(attemptId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "操作人从日志详情页强行中断手动执行的用例。" }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "中断手动执行失败。"))!);
      const result = stopResultSchema.parse(await response.json());
      setRequested(result.cancelled);
      const saved = !rememberChoice || rememberManualStopWarning(browserStorage);
      setOpen(false);
      if (!saved) toast.warning("中断请求已提交；当前浏览器无法保存提醒偏好，下次仍会提醒。");
      else
        toast.info(
          result.cancelled
            ? "中断请求已提交，执行机将停止用例进程；请检查环境中的遗留数据。"
            : "用例已经结束，无需中断。",
        );
      onCancelled();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "中断手动执行失败。";
      setError(message);
      if (!open) toast.error(message);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Button
        variant="danger"
        type="button"
        disabled={pending || requested}
        onClick={() => {
          if (skipManualStopWarning(browserStorage)) void stopExecution(false);
          else {
            setRemember(false);
            setError("");
            setOpen(true);
          }
        }}
      >
        <Square size={15} /> {pending || requested ? "中断中…" : "强行中断"}
      </Button>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        closeDisabled={pending}
        title="中断手动执行"
        className="w-[min(520px,calc(100vw-3rem))]"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              继续执行
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() => void stopExecution(remember)}
            >
              {pending ? "正在中断…" : "确认中断"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Alert
            type="warning"
            showIcon
            title="中断可能留下环境脏数据"
            description="强行中断可能使测试用例无法完成清理，留下测试数据、资源或未恢复的环境状态。请在后续执行前检查并恢复环境。"
          />
          <Checkbox
            checked={remember}
            disabled={pending}
            onChange={(event) => setRemember(event.target.checked)}
          >
            后续中断操作不再提醒
          </Checkbox>
          <p className="m-0 text-xs text-muted-foreground">
            仅保存在当前浏览器，清理浏览器缓存后恢复提醒。
          </p>
          {error ? <Alert type="error" showIcon title={error} /> : null}
        </div>
      </ActionDialog>
    </>
  );
}
