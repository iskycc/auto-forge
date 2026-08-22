"use client";

import type { CaseSuiteSchedule, LdapSyncJob } from "@autoforge/contracts";
import { CalendarClock, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

const RELOAD_MESSAGE_KEY = "autoforge:automation-operations:message";

export function AutomationOperations({
  schedules,
  suites,
  ldapJobs,
  manageableScheduleProjectIds,
  canManageLdap,
}: {
  schedules: CaseSuiteSchedule[];
  suites: Array<{ id: string; name: string }>;
  ldapJobs: LdapSyncJob[];
  manageableScheduleProjectIds: string[] | undefined;
  canManageLdap: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setMessage(takeReloadMessage());
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  async function request(path: string, init: RequestInit, success: string) {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(path, init);
      const errorMessage = await readApiErrorMessage(response, "操作失败。");
      if (errorMessage) throw new Error(errorMessage);
      window.sessionStorage.setItem(RELOAD_MESSAGE_KEY, success);
      window.location.reload();
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

      {ldapJobs.length > 0 || canManageLdap ? (
        <section className="content-card settings-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Directory jobs</p>
              <h2>LDAP 同步历史</h2>
            </div>
            {canManageLdap ? (
              <Button
                className="secondary-button"
                disabled={pending}
                onClick={() =>
                  void request(
                    "/api/v1/ldap/synchronize",
                    { method: "POST" },
                    "LDAP 同步作业已完成。",
                  )
                }
                type="button"
              >
                <RefreshCw size={16} /> 立即同步 / 重试
              </Button>
            ) : null}
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>作业</th>
                  <th>触发与状态</th>
                  <th>进度 / 检查点</th>
                  <th>处理结果</th>
                  <th>错误摘要</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {ldapJobs.length === 0 ? (
                  <tr>
                    <td colSpan={6}>还没有 LDAP 同步记录。</td>
                  </tr>
                ) : null}
                {ldapJobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <code>{job.id}</code>
                    </td>
                    <td>
                      {job.triggerKind === "manual" ? "手动" : "计划"} ·{" "}
                      {jobStatusLabel(job.status)}
                    </td>
                    <td>
                      {job.status === "queued"
                        ? "等待执行"
                        : job.status === "running"
                          ? "同步中"
                          : job.status === "succeeded"
                            ? "100%"
                            : "已停止"}
                      <details>
                        <summary className="role-action-summary">检查点</summary>
                        <pre>{JSON.stringify(job.checkpoint, null, 2)}</pre>
                      </details>
                    </td>
                    <td>
                      更新 {job.processedUsers} · 停用 {job.disabledUsers}
                    </td>
                    <td>
                      {job.errorCode ? (
                        <>
                          <code>{job.errorCode}</code>
                          <small>{job.errorSummary}</small>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {formatDate(job.scheduledAt)}
                      <small>
                        {job.finishedAt ? `完成：${formatDate(job.finishedAt)}` : "未完成"}
                      </small>
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

function jobStatusLabel(status: LdapSyncJob["status"]): string {
  return {
    queued: "排队中",
    running: "执行中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
  }[status];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function takeReloadMessage(): string {
  if (typeof window === "undefined") return "";
  const message = window.sessionStorage.getItem(RELOAD_MESSAGE_KEY) ?? "";
  window.sessionStorage.removeItem(RELOAD_MESSAGE_KEY);
  return message;
}
