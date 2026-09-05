import type { CaseSuiteSchedule } from "@autoforge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform-date-time", () => import("../lib/platform-date-time"));

import {
  CaseSuiteScheduleSummary,
  nextSuiteTriggerLabel,
  type ScheduledSuite,
} from "./case-suite-schedule-summary";

const suite: ScheduledSuite = {
  id: "suite-1",
  name: "每日巡检",
  projectId: "project-1",
  projectVersionId: "version-1",
  enabled: true,
  archived: false,
};
const schedule: CaseSuiteSchedule = {
  id: "schedule-1",
  suiteId: suite.id,
  projectId: suite.projectId,
  cronExpression: "0 9 * * 1-5",
  timeZone: "Asia/Shanghai",
  missedRunPolicy: "run-once",
  enabled: true,
  nextTriggerAt: "2026-09-07T01:00:00.000Z",
  revision: 1,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  lastTriggerAt: "2026-09-04T01:00:00.000Z",
  lastTriggerStatus: "created",
  lastBatchId: "batch-1",
};

describe("task schedule summary", () => {
  it("shows the planned time in the display time zone and preserves UTC inspection", () => {
    const html = renderToStaticMarkup(
      createElement(CaseSuiteScheduleSummary, { suite, schedule, canReadExecutions: true }),
    );
    expect(html).toContain("09:00:00");
    expect(html).toContain(`UTC：${schedule.nextTriggerAt}`);
    expect(html).toContain(`UTC：${schedule.lastTriggerAt}`);
    expect(html).toContain("已创建执行批次");
    expect(html).toContain('href="/run-batches/batch-1"');
  });

  it("does not present stale next-trigger timestamps as runnable when paused, disabled or archived", () => {
    expect(nextSuiteTriggerLabel({ ...schedule, enabled: false }, suite)).toContain("计划已暂停");
    expect(nextSuiteTriggerLabel(schedule, { ...suite, enabled: false })).toContain("任务已停用");
    expect(nextSuiteTriggerLabel(schedule, { ...suite, archived: true })).toContain("任务已归档");
    const html = renderToStaticMarkup(
      createElement(CaseSuiteScheduleSummary, {
        suite,
        schedule: { ...schedule, enabled: false },
        canReadExecutions: true,
      }),
    );
    expect(html).not.toContain(schedule.nextTriggerAt);
  });

  it("explains unconfigured plans and hides execution links without run permission", () => {
    const empty = renderToStaticMarkup(
      createElement(CaseSuiteScheduleSummary, { suite, schedule: null, canReadExecutions: false }),
    );
    expect(empty).toContain("尚未配置自动执行计划");
    const restricted = renderToStaticMarkup(
      createElement(CaseSuiteScheduleSummary, {
        suite,
        schedule: { ...schedule, lastTriggerStatus: "failed" },
        canReadExecutions: false,
      }),
    );
    expect(restricted).toContain("触发失败，请检查任务状态和执行配置");
    expect(restricted).not.toContain("/run-batches/");
  });
});
