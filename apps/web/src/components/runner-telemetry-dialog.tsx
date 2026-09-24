"use client";

import { useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Alert, Card, Collapse, Descriptions, Empty, Skeleton, Statistic, Tag, theme } from "antd";
import type { RunnerTelemetry } from "@autoforge/domain";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui";
import { readApiError } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { RunnerResourceChart } from "./runner-resource-chart";

export function RunnerTelemetryButton({
  runnerId,
  runnerName,
}: {
  runnerId: string;
  runnerName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="compact"
        onClick={() => setOpen(true)}
        aria-label={`查看 ${runnerName} 的资源监控`}
      >
        <Activity size={14} /> 资源监控
      </Button>
      {open ? (
        <RunnerTelemetryDialog
          runnerId={runnerId}
          runnerName={runnerName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function RunnerTelemetryDialog({
  runnerId,
  runnerName,
  onClose,
}: {
  runnerId: string;
  runnerName: string;
  onClose(): void;
}) {
  const [telemetry, setTelemetry] = useState<RunnerTelemetry>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`/api/v1/runners/${encodeURIComponent(runnerId)}/telemetry`, {
          signal: controller.signal,
        });
        const failure = await readApiError(response, "读取执行节点资源监控失败，请重试。");
        if (failure) throw failure;
        const result = (await response.json()) as RunnerTelemetry;
        if (!controller.signal.aborted) setTelemetry(result);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "读取资源监控失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [runnerId, revision]);
  return (
    <ActionDialog
      open
      title={`${runnerName} · 资源监控`}
      description="最近 6 小时 · 每分钟保留一份心跳样本 · 未上报时段留空，不补零"
      className="w-[min(1080px,calc(100vw_-_64px))]"
      onClose={onClose}
    >
      <div className="grid min-w-0 gap-4" aria-busy={loading}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {telemetry
              ? `统计截至 ${formatPlatformDateTime(telemetry.until)}`
              : "正在读取节点上报信息…"}
          </span>
          <Button type="button" loading={loading} onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw size={14} /> 刷新监控
          </Button>
        </div>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {telemetry ? (
          <TelemetryContent telemetry={telemetry} />
        ) : loading ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : null}
      </div>
    </ActionDialog>
  );
}

function TelemetryContent({ telemetry }: { telemetry: RunnerTelemetry }) {
  const { runner, samples, since, until } = telemetry;
  const { token } = theme.useToken();
  const snapshot = runner.resourceSnapshot;
  const stateLabel = { online: "在线", offline: "离线", draining: "排空中", disabled: "已禁用" }[
    runner.state
  ];
  const recentSample = snapshot && Date.parse(until) - Date.parse(snapshot.observedAt) <= 45_000;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Tag color={runner.state === "online" ? "success" : "default"}>{stateLabel}</Tag>
        <span>
          最近心跳：
          <time dateTime={runner.lastSeenAt} title={runner.lastSeenAt}>
            {formatPlatformDateTime(runner.lastSeenAt)}
          </time>
        </span>
        {!recentSample ? <Tag color="warning">以下为最近上报数据，非当前实时值</Tag> : null}
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Card size="small">
          <Statistic
            title="CPU 使用率"
            value={snapshot?.cpuUtilizationPercent ?? "—"}
            precision={1}
            suffix={snapshot ? "%" : ""}
          />
        </Card>
        <Card size="small">
          <Statistic
            title="内存使用率"
            value={snapshot?.memoryUtilizationPercent ?? "—"}
            precision={1}
            suffix={snapshot ? "%" : ""}
          />
        </Card>
        <Card size="small">
          <Statistic
            title="1 分钟负载 / 逻辑 CPU"
            value={snapshot?.loadAverage1m ?? "—"}
            precision={2}
            suffix={snapshot ? `/ ${snapshot.logicalCpuCount}` : ""}
          />
        </Card>
        <Card size="small">
          <Statistic
            title="执行槽位占用"
            value={runner.busySlots}
            suffix={`/ ${runner.maxConcurrency}`}
          />
        </Card>
      </div>
      {samples.length ? (
        <div className="grid min-w-0 grid-cols-3 gap-3">
          <RunnerResourceChart
            title="CPU / 内存使用率"
            samples={samples}
            since={since}
            until={until}
            maximum={100}
            unit="%"
            series={[
              {
                label: "CPU",
                color: token.colorPrimary,
                value: (sample) => sample.cpuUtilizationPercent,
              },
              {
                label: "内存",
                color: token.colorSuccess,
                value: (sample) => sample.memoryUtilizationPercent,
              },
            ]}
          />
          <RunnerResourceChart
            title="每核平均负载"
            samples={samples}
            since={since}
            until={until}
            unit=""
            series={[
              {
                label: "负载 / CPU",
                color: token.colorWarning,
                value: (sample) => sample.loadAverage1m / Math.max(1, sample.logicalCpuCount),
              },
            ]}
          />
          <RunnerResourceChart
            title="执行槽位"
            samples={samples}
            since={since}
            until={until}
            unit=""
            series={[
              { label: "使用", color: token.colorPrimary, value: (sample) => sample.busySlots },
              {
                label: "容量",
                color: token.colorTextSecondary,
                value: (sample) => sample.maxConcurrency,
              },
            ]}
          />
        </div>
      ) : (
        <Empty description="暂无资源历史；Agent 上报资源心跳后开始积累，升级前的数据不会补造。" />
      )}
      <Collapse
        size="small"
        items={[
          {
            key: "agent",
            label: "Agent 上报详情",
            children: (
              <Descriptions
                size="small"
                column={3}
                items={[
                  { key: "version", label: "Agent 版本", children: runner.agentVersion },
                  {
                    key: "system",
                    label: "系统 / 架构",
                    children: `${runner.os} / ${runner.architecture}`,
                  },
                  { key: "protocol", label: "协议版本", children: `v${runner.protocolVersion}` },
                  {
                    key: "cpus",
                    label: "逻辑 CPU",
                    children: snapshot?.logicalCpuCount ?? "未上报",
                  },
                  {
                    key: "terminal",
                    label: "直接终端",
                    children: runner.terminalEnabled ? "已启用" : "未启用",
                  },
                  { key: "samples", label: "历史样本", children: `${samples.length} / 360` },
                  {
                    key: "labels",
                    label: "标签",
                    span: 3,
                    children: <span className="break-all">{runner.labels.join("、") || "无"}</span>,
                  },
                  {
                    key: "capabilities",
                    label: "能力",
                    span: 3,
                    children: (
                      <span className="break-all">
                        {runner.capabilities.join("、") || "未上报"}
                      </span>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </>
  );
}
