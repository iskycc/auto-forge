"use client";

import { caseSuiteScheduleSchema, type CaseSuiteSchedule } from "@autoforge/contracts";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { CaseSuiteRecentExecutions } from "@/components/case-suite-recent-executions";
import {
  CaseSuiteScheduleSummary,
  type ScheduledSuite,
} from "@/components/case-suite-schedule-summary";
import { Button } from "@/components/ui";
import { readApiError } from "@/lib/client-api";

type ScheduleState =
  | { status: "loading" }
  | { status: "ready"; schedule: CaseSuiteSchedule | null }
  | { status: "error"; message: string };

export function CaseSuiteScheduleDialog({
  suite,
  canReadExecutions,
  open,
  onClose,
}: {
  suite: ScheduledSuite;
  canReadExecutions: boolean;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <ActionDialog
      className="suite-schedule-dialog"
      description={suite.name}
      title="执行历史与计划"
      open={open}
      onClose={onClose}
    >
      {open ? <ScheduleDialogContent suite={suite} canReadExecutions={canReadExecutions} /> : null}
    </ActionDialog>
  );
}

function ScheduleDialogContent({
  suite,
  canReadExecutions,
}: {
  suite: ScheduledSuite;
  canReadExecutions: boolean;
}) {
  const [state, setState] = useState<ScheduleState>({ status: "loading" });
  const [refreshSequence, setRefreshSequence] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const response = await fetch(
          `/api/v1/case-suites/${encodeURIComponent(suite.id)}/schedule`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const failure = await readApiError(response, "执行计划加载失败，请重试。");
        if (failure) throw failure;
        const schedule = caseSuiteScheduleSchema.nullable().parse(await response.json());
        if (!controller.signal.aborted) setState({ status: "ready", schedule });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: !navigator.onLine
            ? "当前网络已离线，恢复连接后请重试。"
            : cause instanceof Error
              ? cause.message
              : "执行计划加载失败，请重试。",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [suite.id, refreshSequence]);

  function refresh(): void {
    setState({ status: "loading" });
    setRefreshSequence((current) => current + 1);
  }

  return (
    <div className="suite-schedule-dialog-content">
      <div className="button-row">
        <Button disabled={state.status === "loading"} onClick={refresh} type="button">
          <RefreshCw size={15} /> 刷新计划与历史
        </Button>
      </div>
      {state.status === "loading" ? (
        <p role="status">
          <LoaderCircle className="spin" size={16} /> 正在加载执行计划…
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="suite-history-feedback" role="alert">
          <span>{state.message}</span>
          <Button onClick={refresh} type="button">
            重试
          </Button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <CaseSuiteScheduleSummary
          schedule={state.schedule}
          suite={suite}
          canReadExecutions={canReadExecutions}
        />
      ) : null}
      {canReadExecutions && suite.projectVersionId ? (
        <CaseSuiteRecentExecutions
          key={refreshSequence}
          suiteId={suite.id}
          projectId={suite.projectId}
          projectVersionId={suite.projectVersionId}
          view="history"
        />
      ) : (
        <p className="suite-history-feedback">
          {!canReadExecutions
            ? "当前账号无执行记录查看权限。"
            : "任务尚未关联项目版本，无法查询执行历史。"}
        </p>
      )}
    </div>
  );
}
