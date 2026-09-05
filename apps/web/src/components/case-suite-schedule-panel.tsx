"use client";

import { caseSuiteScheduleSchema, type CaseSuiteSchedule } from "@autoforge/contracts";
import { CalendarClock, History, LoaderCircle, Pause, Play, Save, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { CaseSuiteScheduleDialog } from "@/components/case-suite-schedule-dialog";
import {
  nextSuiteTriggerLabel,
  type ScheduledSuite,
} from "@/components/case-suite-schedule-summary";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { Button, Input, Select } from "@/components/ui";
import { useConfirm, useToast } from "@/components/ui-feedback";
import { readApiError } from "@/lib/client-api";
import { activePlatformTimeZone } from "@/lib/platform-date-time";

export function CaseSuiteSchedulePanel({
  suite,
  initialSchedule,
  canManage,
  canReadExecutions,
}: {
  suite: ScheduledSuite;
  initialSchedule: CaseSuiteSchedule | null;
  canManage: boolean;
  canReadExecutions: boolean;
}) {
  const [schedule, setSchedule] = useState(initialSchedule);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmAction = useConfirm();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const toast = useToast();
  const endpoint = `/api/v1/case-suites/${encodeURIComponent(suite.id)}/schedule`;

  async function mutate(init: RequestInit, success: string): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(endpoint, init);
      const failure = await readApiError(response, "计划操作失败，请重试。");
      if (failure) throw failure;
      setSchedule(
        init.method === "DELETE" ? null : caseSuiteScheduleSchema.parse(await response.json()),
      );
      toast.success(success);
    } catch (cause) {
      if (await showConcurrentModification(cause)) return;
      setError(
        !navigator.onLine
          ? "当前网络已离线，恢复连接后请重试。"
          : cause instanceof Error
            ? cause.message
            : "计划操作失败，请重试。",
      );
    } finally {
      setPending(false);
    }
  }

  async function saveSchedule(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate(
      scheduleRequest({
        cronExpression: form.get("cronExpression"),
        timeZone: form.get("timeZone"),
        missedRunPolicy: form.get("missedRunPolicy"),
        enabled: form.get("scheduleEnabled") === "on",
        ...(schedule ? { expectedRevision: schedule.revision } : {}),
      }),
      "计划触发已保存。",
    );
  }

  async function toggleSchedule(): Promise<void> {
    if (!schedule) return;
    await mutate(
      scheduleRequest({
        cronExpression: schedule.cronExpression,
        timeZone: schedule.timeZone,
        missedRunPolicy: schedule.missedRunPolicy,
        enabled: !schedule.enabled,
        expectedRevision: schedule.revision,
      }),
      schedule.enabled ? "计划已暂停。" : "计划已启用。",
    );
  }

  async function deleteSchedule(): Promise<void> {
    if (
      !schedule ||
      !(await confirmAction({
        title: "删除执行计划",
        description: "删除后任务不再自动触发，已经创建的执行批次及其历史记录仍会保留。",
        confirmLabel: "确认删除",
        tone: "danger",
      }))
    )
      return;
    await mutate({ method: "DELETE" }, "执行计划已删除。");
  }

  return (
    <section className="content-card suite-schedule-panel" aria-label="任务执行计划">
      <header className="section-heading">
        <div>
          <h2>
            <CalendarClock size={20} /> 执行计划
          </h2>
          <p>下次执行：{nextSuiteTriggerLabel(schedule, suite)}</p>
        </div>
        <Button aria-haspopup="dialog" onClick={() => setDialogOpen(true)} type="button">
          <History size={16} /> 执行历史与计划
        </Button>
      </header>
      {error ? (
        <p className="suite-schedule-error" role="alert">
          {error}
        </p>
      ) : null}
      {canManage ? (
        <form
          key={schedule?.revision ?? "new"}
          className="schedule-form"
          onSubmit={(event) => void saveSchedule(event)}
        >
          <label>
            Cron（分 时 日 月 周）
            <Input
              defaultValue={schedule?.cronExpression ?? "0 9 * * 1-5"}
              name="cronExpression"
              required
              maxLength={120}
              disabled={pending}
            />
          </label>
          <label>
            IANA 时区
            <Input
              defaultValue={schedule?.timeZone ?? activePlatformTimeZone()}
              name="timeZone"
              required
              maxLength={100}
              disabled={pending}
            />
          </label>
          <label>
            错过触发
            <Select
              defaultValue={schedule?.missedRunPolicy ?? "run-once"}
              name="missedRunPolicy"
              disabled={pending}
            >
              <option value="run-once">恢复后补跑一次</option>
              <option value="skip">跳过错过时刻</option>
            </Select>
          </label>
          <label className="checkbox-field schedule-enable-field">
            <Input
              defaultChecked={schedule?.enabled ?? true}
              name="scheduleEnabled"
              type="checkbox"
              disabled={pending}
            />{" "}
            启用计划
          </label>
          <p className="suite-schedule-hint">
            例如 0 9 * * 1-5 表示工作日 09:00 触发。计划始终使用当前任务保存的执行配置。
          </p>
          <div className="schedule-actions">
            {schedule ? (
              <>
                <Button
                  disabled={pending}
                  onClick={() => void deleteSchedule()}
                  type="button"
                  variant="danger"
                >
                  <Trash2 size={15} /> 删除计划
                </Button>
                <Button disabled={pending} onClick={() => void toggleSchedule()} type="button">
                  {schedule.enabled ? <Pause size={15} /> : <Play size={15} />}
                  {schedule.enabled ? "暂停计划" : "恢复计划"}
                </Button>
              </>
            ) : null}
            <Button disabled={pending} type="submit" variant="primary">
              {pending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} 保存计划
            </Button>
          </div>
        </form>
      ) : (
        <p className="suite-schedule-hint">
          当前账号可查看计划与已授权的执行历史，修改计划需要任务管理权限。
        </p>
      )}
      <CaseSuiteScheduleDialog
        suite={suite}
        canReadExecutions={canReadExecutions}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </section>
  );
}

function scheduleRequest(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
