import type { CaseSuiteSchedule } from "@autoforge/contracts";
import Link from "next/link";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

export type ScheduledSuite = {
  id: string;
  name: string;
  projectId: string;
  projectVersionId: string;
  enabled: boolean;
  archived: boolean;
};

export function nextSuiteTriggerLabel(
  schedule: CaseSuiteSchedule | null,
  suite: Pick<ScheduledSuite, "enabled" | "archived">,
): string {
  if (!schedule) return "尚未配置自动执行计划";
  if (!schedule.enabled) return "计划已暂停，不会自动执行";
  if (suite.archived) return "任务已归档，无法自动执行";
  if (!suite.enabled) return "任务已停用，无法自动执行";
  return formatPlatformDateTime(schedule.nextTriggerAt, undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

export function CaseSuiteScheduleSummary({
  schedule,
  suite,
  canReadExecutions,
}: {
  schedule: CaseSuiteSchedule | null;
  suite: ScheduledSuite;
  canReadExecutions: boolean;
}) {
  return (
    <section aria-label="当前执行计划" className="suite-schedule-summary">
      <h3>当前执行计划</h3>
      <dl>
        <div>
          <dt>计划状态</dt>
          <dd>{!schedule ? "尚未配置" : schedule.enabled ? "已启用" : "已暂停"}</dd>
        </div>
        <div>
          <dt>下次执行</dt>
          <dd
            title={
              schedule?.enabled && suite.enabled && !suite.archived
                ? `UTC：${schedule.nextTriggerAt}`
                : undefined
            }
          >
            {nextSuiteTriggerLabel(schedule, suite)}
          </dd>
        </div>
        {schedule ? (
          <>
            <div>
              <dt>Cron 表达式</dt>
              <dd>
                <code>{schedule.cronExpression}</code>
              </dd>
            </div>
            <div>
              <dt>计划时区</dt>
              <dd>{schedule.timeZone}</dd>
            </div>
            <div>
              <dt>错过策略</dt>
              <dd>{schedule.missedRunPolicy === "run-once" ? "恢复后补跑一次" : "跳过错过时刻"}</dd>
            </div>
            <div>
              <dt>上次触发</dt>
              <dd>
                {schedule.lastTriggerAt ? (
                  <time dateTime={schedule.lastTriggerAt} title={`UTC：${schedule.lastTriggerAt}`}>
                    {formatPlatformDateTime(schedule.lastTriggerAt, undefined, {
                      dateStyle: "medium",
                      timeStyle: "medium",
                    })}
                  </time>
                ) : (
                  "尚未触发"
                )}
              </dd>
            </div>
            <div>
              <dt>触发结果</dt>
              <dd>{triggerResultLabel(schedule.lastTriggerStatus)}</dd>
            </div>
            {schedule.lastBatchId && canReadExecutions ? (
              <div>
                <dt>关联执行</dt>
                <dd>
                  <Link href={`/run-batches/${encodeURIComponent(schedule.lastBatchId)}`}>
                    查看上次计划执行
                  </Link>
                </dd>
              </div>
            ) : null}
          </>
        ) : null}
      </dl>
      <p>
        下次执行显示计划触发时间，实际开始取决于任务预检和执行机可用情况。历史包含当前任务的手动、计划和
        Jenkins 执行。
      </p>
    </section>
  );
}

function triggerResultLabel(status: CaseSuiteSchedule["lastTriggerStatus"]): string {
  switch (status) {
    case "created":
      return "已创建执行批次";
    case "skipped":
      return "已跳过错过的触发";
    case "failed":
      return "触发失败，请检查任务状态和执行配置";
    default:
      return "暂无触发结果";
  }
}
