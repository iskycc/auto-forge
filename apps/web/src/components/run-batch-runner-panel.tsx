"use client";

import { Progress as AntProgress, Tooltip } from "antd";
import { Cpu, ScrollText, Server } from "lucide-react";
import type { RunnerResourceSnapshot } from "@autoforge/domain";
import type { ExecutionBatchView } from "@/lib/execution-batch-view";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import type { RunnerDirectoryEntry } from "./run-batch-rounds";
import { RunnerTelemetryButton } from "./runner-telemetry-dialog";
import { Button } from "./ui";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { EmptyState } from "./ui/empty-state";
import { Progress } from "./ui/progress";

type RunnerRound = ExecutionBatchView["runnerRoundSummaries"][number];

export function RunBatchRunnerPanel({
  batch,
  round,
  canReadLogs,
  runnerDirectory,
  onOpenScheduling,
}: {
  batch: ExecutionBatchView;
  round: number;
  canReadLogs: boolean;
  runnerDirectory: ReadonlyMap<string, RunnerDirectoryEntry>;
  onOpenScheduling: (runnerId: string | undefined) => void;
}) {
  const runners = batch.runnerRoundSummaries.filter((summary) => summary.round === round);
  const totals = runners.reduce(
    (result, runner) => ({
      executed: result.executed + runner.executed,
      passed: result.passed + runner.passed,
      failed: result.failed + runner.failed,
      other: result.other + otherAttempts(runner),
    }),
    { executed: 0, passed: 0, failed: 0, other: 0 },
  );

  return (
    <section className="grid min-w-0 gap-4" aria-label="本轮执行机状态">
      <div className="grid grid-cols-5 gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <OverviewMetric label="参与节点" value={runners.length} />
        <OverviewMetric label="本轮尝试" value={totals.executed} accessibleLabel="本轮尝试总数" />
        <OverviewMetric label="通过" value={totals.passed} accessibleLabel="本轮通过总数" />
        <OverviewMetric
          label="失败 / 超时"
          value={totals.failed}
          accessibleLabel="本轮失败或超时总数"
        />
        <OverviewMetric label="其他状态" value={totals.other} accessibleLabel="本轮其他状态总数" />
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">
        按本轮执行尝试统计，同一用例重调度会计入多次。其他状态包含进行中、取消或阻塞；节点资源为最近上报快照，非本轮历史资源。
      </p>
      {runners.length === 0 ? (
        <EmptyState>本轮还没有执行机参与执行；任务分配后将在这里显示。</EmptyState>
      ) : (
        <div className="runner-card-grid grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
          {runners.map((runner) => (
            <RunnerRoundCard
              key={runner.runnerId}
              runner={runner}
              entry={runnerDirectory.get(runner.runnerId)}
              canReadLogs={canReadLogs}
              onOpenScheduling={onOpenScheduling}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function OverviewMetric({
  label,
  value,
  accessibleLabel,
}: {
  label: string;
  value: number;
  accessibleLabel?: string;
}) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong
        className="text-lg font-semibold tabular-nums [overflow-wrap:anywhere]"
        aria-label={accessibleLabel}
      >
        {value.toLocaleString()}
      </strong>
    </div>
  );
}

function otherAttempts(runner: RunnerRound): number {
  // The overview does not separate running, blocked and cancelled attempts;
  // treating this remainder as running would mislabel terminal history.
  return Math.max(0, runner.executed - runner.passed - runner.failed);
}

function RunnerRoundCard({
  runner,
  entry,
  canReadLogs,
  onOpenScheduling,
}: {
  runner: RunnerRound;
  entry: RunnerDirectoryEntry | undefined;
  canReadLogs: boolean;
  onOpenScheduling: (runnerId: string | undefined) => void;
}) {
  const name = entry?.name || runner.runnerId.slice(0, 8);
  const other = otherAttempts(runner);
  const passedPercent = runner.executed > 0 ? (runner.passed / runner.executed) * 100 : 0;
  const finishedPercent =
    runner.executed > 0 ? ((runner.passed + runner.failed) / runner.executed) * 100 : 0;
  return (
    <Card className="runner-card flex min-w-0 flex-col gap-3 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Server size={16} aria-hidden="true" />
        </span>
        <div className="grid min-w-0 flex-1 gap-2">
          <Tooltip title={name}>
            <strong className="line-clamp-2 min-h-10 text-sm leading-5 [overflow-wrap:anywhere]">
              {name}
            </strong>
          </Tooltip>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={runner.failed > 0 ? "warning" : other > 0 ? "secondary" : "success"}>
              {runner.failed > 0 ? "有失败 / 超时" : other > 0 ? "含其他状态" : "全部通过"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {runner.executed.toLocaleString()} 次尝试
            </span>
          </div>
        </div>
      </div>
      <div className="grid gap-2">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <ResultCount label="通过" value={runner.passed} className="text-success" />
          <ResultCount label="失败 / 超时" value={runner.failed} className="text-destructive" />
          <ResultCount label="其他状态" value={other} className="text-muted-foreground" />
        </div>
        <AntProgress
          className="m-0"
          size="small"
          percent={finishedPercent}
          success={{ percent: passedPercent, strokeColor: "var(--success)" }}
          strokeColor="var(--destructive)"
          railColor="var(--border)"
          status="normal"
          showInfo={false}
          styles={{ body: { display: "flex" } }}
          aria-label={`本轮结果分布：通过 ${runner.passed}，失败或超时 ${runner.failed}，其他状态 ${other}`}
        />
      </div>
      <div className="grid min-w-0 flex-1 content-start gap-2 rounded-lg bg-muted/40 p-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Cpu size={14} aria-hidden="true" /> 节点资源快照
        </span>
        {entry?.resourceSnapshot ? (
          <ResourceSnapshot snapshot={entry.resourceSnapshot} />
        ) : (
          <EmptyState className="py-2">{entry ? "尚无资源快照" : "未读取节点资料"}</EmptyState>
        )}
      </div>
      <div className="mt-auto grid min-w-0 gap-3 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          本轮最后活动{" "}
          <time dateTime={runner.lastActivity} title={`UTC ${runner.lastActivity}`}>
            {formatLocalDateTime(runner.lastActivity)}
          </time>
        </span>
        {canReadLogs || entry?.canReadTelemetry ? (
          <div className="flex flex-wrap items-center gap-2">
            {canReadLogs ? (
              <Button
                type="button"
                size="compact"
                variant="secondary"
                onClick={() => onOpenScheduling(runner.runnerId)}
              >
                <ScrollText size={14} /> 调度日志
              </Button>
            ) : null}
            {entry?.canReadTelemetry ? (
              <RunnerTelemetryButton runnerId={runner.runnerId} runnerName={name} />
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function ResultCount({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-muted-foreground">{label}</span>
      <strong className={`text-base font-semibold tabular-nums ${className}`}>
        {value.toLocaleString()}
      </strong>
    </div>
  );
}

function ResourceSnapshot({ snapshot }: { snapshot: RunnerResourceSnapshot }) {
  const loadPerCpu =
    snapshot.logicalCpuCount > 0 ? snapshot.loadAverage1m / snapshot.logicalCpuCount : undefined;
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <ResourceMeter label="CPU 使用率" value={snapshot.cpuUtilizationPercent} />
        <ResourceMeter label="内存使用率" value={snapshot.memoryUtilizationPercent} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{snapshot.logicalCpuCount} 个逻辑 CPU</span>
        <Tooltip title="1 分钟负载除以逻辑 CPU 数，不等同于 CPU 使用率。">
          <span>负载 / CPU {loadPerCpu?.toFixed(2) ?? "—"}</span>
        </Tooltip>
      </div>
      <span className="text-xs text-muted-foreground">
        采集于{" "}
        <time dateTime={snapshot.observedAt} title={`UTC ${snapshot.observedAt}`}>
          {formatLocalDateTime(snapshot.observedAt)}
        </time>
      </span>
    </>
  );
}

function ResourceMeter({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%
        </span>
      </div>
      <Progress value={value} role="progressbar" aria-label={label} />
    </div>
  );
}
