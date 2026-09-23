"use client";
import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

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
  const [previousSchedule, setPreviousSchedule] = useState(initialSchedule);
  if (
    previousSchedule?.id !== initialSchedule?.id ||
    previousSchedule?.revision !== initialSchedule?.revision
  ) {
    setPreviousSchedule(initialSchedule);
    if (
      !initialSchedule ||
      !schedule ||
      initialSchedule.id !== schedule.id ||
      initialSchedule.revision >= schedule.revision
    ) {
      setSchedule(initialSchedule);
    }
  }
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
    <Card
      as="section"
      className={cn(
        "content-card suite-schedule-panel",
        uiPatterns["content-card"],
        caseSuiteSchedulePanelStyles["suite-schedule-panel"],
      )}
      aria-label="任务执行计划"
    >
      <header className={cn("section-heading", uiPatterns["section-heading"])}>
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
        <p
          className={cn(
            "suite-schedule-error",
            caseSuiteSchedulePanelStyles["suite-schedule-error"],
          )}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {canManage ? (
        <form
          key={schedule?.revision ?? "new"}
          className={cn("schedule-form", caseSuiteSchedulePanelStyles["schedule-form"])}
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
          <label
            className={cn("checkbox-field schedule-enable-field", uiPatterns["checkbox-field"])}
          >
            <Input
              defaultChecked={schedule?.enabled ?? true}
              name="scheduleEnabled"
              type="checkbox"
              disabled={pending}
            />{" "}
            启用计划
          </label>
          <p
            className={cn(
              "suite-schedule-hint",
              caseSuiteSchedulePanelStyles["suite-schedule-hint"],
            )}
          >
            例如 0 9 * * 1-5 表示工作日 09:00 触发。计划始终使用当前任务保存的执行配置。
          </p>
          <div className={cn("schedule-actions", caseSuiteSchedulePanelStyles["schedule-actions"])}>
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
              {pending ? (
                <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={15} />
              ) : (
                <Save size={15} />
              )}{" "}
              保存计划
            </Button>
          </div>
        </form>
      ) : (
        <p
          className={cn("suite-schedule-hint", caseSuiteSchedulePanelStyles["suite-schedule-hint"])}
        >
          当前账号可查看计划与已授权的执行历史，修改计划需要任务管理权限。
        </p>
      )}
      <CaseSuiteScheduleDialog
        suite={suite}
        canReadExecutions={canReadExecutions}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </Card>
  );
}

function scheduleRequest(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

const caseSuiteSchedulePanelStyles = {
  "schedule-actions": "flex gap-2 col-span-full items-center justify-end",
  "schedule-form":
    "grid grid-cols-3 gap-4 items-end p-5 border-t border-solid border-border [&_label]:grid [&_label]:gap-2 [&_label]:text-muted-foreground [&_label]:text-xs [&_label]:font-semibold [&_.schedule-enable-field]:col-span-full [&_.schedule-enable-field]:flex [&_.schedule-enable-field]:items-center [&_.schedule-enable-field]:gap-2 [&_.schedule-enable-field]:whitespace-nowrap max-[1181px]:grid-cols-[repeat(2,_minmax(220px,_1fr))]",
  "suite-schedule-error": "m-0 [padding:0_20px_20px] text-destructive",
  "suite-schedule-hint": "col-span-full m-0 text-muted-foreground text-xs leading-[1.6]",
  "suite-schedule-panel":
    "[&_.ui-card-content_>_.section-heading]:flex [&_.ui-card-content_>_.section-heading]:items-center [&_.ui-card-content_>_.section-heading]:gap-3 [&_.ui-card-content_>_.section-heading]:justify-between [&_.ui-card-content_>_.section-heading]:flex-wrap [&_.ui-card-content_>_.section-heading]:m-0 [&_.ui-card-content_>_.section-heading]:p-5 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-3 [&_h2]:m-0 [&_.ui-card-content_>_.section-heading_>_div]:block [&_.ui-card-content_>_.section-heading_>_div]:min-w-0 [&_.section-heading_p]:[margin:8px_0_0] [&_.section-heading_p]:text-muted-foreground [&_.section-heading_p]:text-sm [&_.ui-card-content_>_.suite-schedule-hint]:m-0 [&_.ui-card-content_>_.suite-schedule-hint]:[padding:0_20px_20px]",
} as const;
