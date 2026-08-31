"use client";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import type { CaseSuiteSchedule } from "@autoforge/contracts";
import { CalendarClock, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

export function AutomationOperations({
  schedules,
  suites,
  manageableScheduleProjectIds,
}: {
  schedules: CaseSuiteSchedule[];
  suites: Array<{ id: string; name: string }>;
  manageableScheduleProjectIds: string[] | undefined;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function request(path: string, init: RequestInit, success: string) {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(path, init);
      const errorMessage = await readApiErrorMessage(response, "操作失败。");
      if (errorMessage) throw new Error(errorMessage);
      setMessage(success);
      router.refresh();
      setPending(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
      setPending(false);
    }
  }

  function canManageSchedule(schedule: CaseSuiteSchedule): boolean {
    return (
      manageableScheduleProjectIds === undefined ||
      manageableScheduleProjectIds.includes(schedule.projectId)
    );
  }

  return (
    <div className="settings-stack">
      {message ? <div className="inline-success">{message}</div> : null}
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}

      {schedules.length > 0 || suites.length > 0 ? (
        <section className="content-card settings-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Schedules</p>
              <h2>计划任务总览</h2>
            </div>
            <CalendarClock size={22} aria-hidden="true" />
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>用例任务</th>
                  <th>Cron / 时区</th>
                  <th>状态与错过策略</th>
                  <th>上次 / 下次触发</th>
                  <th>关联批次</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {schedules.length === 0 ? (
                  <tr>
                    <td colSpan={6}>当前授权项目还没有计划任务。</td>
                  </tr>
                ) : null}
                {schedules.map((schedule) => (
                  <tr key={schedule.id}>
                    <td>
                      <span className="table-cell-stack">
                        <Link href={`/case-suites/${schedule.suiteId}`}>
                          {suiteName(suites, schedule.suiteId)}
                        </Link>
                        <small title={schedule.suiteId}>
                          任务 ID · {shortId(schedule.suiteId)}
                        </small>
                      </span>
                    </td>
                    <td>
                      <span className="table-cell-stack">
                        <code className="cron-expression">{schedule.cronExpression}</code>
                        <small>{schedule.timeZone}</small>
                      </span>
                    </td>
                    <td>
                      {schedule.enabled ? "启用" : "暂停"}
                      <small>
                        {schedule.missedRunPolicy === "run-once" ? "错过后补跑一次" : "错过后跳过"}
                        {schedule.lastTriggerStatus
                          ? ` · 上次${triggerStatusLabel(schedule.lastTriggerStatus)}`
                          : ""}
                      </small>
                    </td>
                    <td>
                      <span className="table-cell-stack">
                        <span>
                          上次：
                          {schedule.lastTriggerAt ? formatDate(schedule.lastTriggerAt) : "尚未触发"}
                        </span>
                        <small>下次：{formatDate(schedule.nextTriggerAt)}</small>
                      </span>
                    </td>
                    <td>
                      {schedule.lastBatchId ? (
                        <Link href={`/run-batches/${schedule.lastBatchId}`}>
                          批次 {shortId(schedule.lastBatchId)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {canManageSchedule(schedule) ? (
                        <span className="button-row">
                          <Link
                            className="button button-secondary"
                            href={`/case-suites/${schedule.suiteId}`}
                          >
                            编辑
                          </Link>
                          <Button
                            className="table-action"
                            disabled={pending}
                            onClick={() =>
                              void request(
                                `/api/v1/case-suites/${schedule.suiteId}/schedule`,
                                jsonRequest("PUT", {
                                  cronExpression: schedule.cronExpression,
                                  timeZone: schedule.timeZone,
                                  missedRunPolicy: schedule.missedRunPolicy,
                                  enabled: !schedule.enabled,
                                  expectedRevision: schedule.revision,
                                }),
                                schedule.enabled ? "计划已暂停。" : "计划已启用。",
                              )
                            }
                            type="button"
                          >
                            {schedule.enabled ? "暂停" : "启用"}
                          </Button>
                          <Button
                            className="table-action"
                            disabled={pending}
                            onClick={() => {
                              if (!window.confirm("删除这条计划任务？删除后不会再自动触发。")) {
                                return;
                              }
                              void request(
                                `/api/v1/case-suites/${schedule.suiteId}/schedule`,
                                { method: "DELETE" },
                                "计划任务已删除。",
                              );
                            }}
                            type="button"
                            variant="danger"
                          >
                            <Trash2 size={14} aria-hidden="true" /> 删除
                          </Button>
                        </span>
                      ) : (
                        "仅查看"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function suiteName(suites: Array<{ id: string; name: string }>, suiteId: string): string {
  return suites.find((suite) => suite.id === suiteId)?.name ?? suiteId;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function triggerStatusLabel(status: NonNullable<CaseSuiteSchedule["lastTriggerStatus"]>): string {
  return status === "created" ? "已创建批次" : status === "skipped" ? "已跳过" : "失败";
}

function formatDate(value: string): string {
  return formatPlatformDateTime(value, undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}
