"use client";

import { Alert, Button, Descriptions, Flex, Skeleton, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  infrastructureUsageSchema,
  type InfrastructureDependency,
  type InfrastructureMetric,
  type InfrastructureUsage,
} from "@autoforge/contracts";
import { readApiError } from "@/lib/client-api";
import { formatDiskBytes } from "@/lib/runner-disk";
import { formatArtifactBytes } from "@/lib/run-batch-presentation";
import { ActionDialog } from "./action-dialog";
import { PostgresCapacityPanel } from "./postgres-capacity-panel";

export function InfrastructureUsageDialog({
  dependency,
  label,
  onClose,
}: {
  dependency: InfrastructureDependency;
  label: string;
  onClose(): void;
}) {
  const [usage, setUsage] = useState<InfrastructureUsage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (force = false) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/v1/settings/diagnostics/usage?${new URLSearchParams({ dependency, ...(force ? { refresh: "1" } : {}) })}`,
          {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          },
        );
        if (!response.ok) throw await readApiError(response, "读取中间件使用信息失败。");
        const report = infrastructureUsageSchema.parse(await response.json());
        if (!controller.signal.aborted) setUsage(report);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取使用信息失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [dependency],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      pending.current?.abort();
    };
  }, [refresh]);
  return (
    <ActionDialog
      open
      title={`${label}使用详情`}
      description="按需读取运行指标，15 秒内复用快照；查看信息不会更改中间件配置。"
      onClose={onClose}
      className="w-[min(820px,calc(100vw-3rem))]"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Flex justify="space-between" align="center" gap="small" wrap>
          <Typography.Text type="secondary">
            {usage
              ? `${usage.provider} · 采样 ${new Date(usage.sampledAt).toLocaleString("zh-CN")}`
              : loading
                ? "正在读取使用信息…"
                : "尚未获取运行指标"}
          </Typography.Text>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh(true)}>
            刷新指标
          </Button>
        </Flex>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {!usage && loading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
        {usage?.status === "unavailable" ? (
          <Alert
            type="warning"
            showIcon
            title="运行指标暂不可用"
            description="连接健康和运行指标分别检查，请确认统计权限与服务状态后刷新。"
          />
        ) : null}
        {usage?.metrics.length ? (
          <Descriptions
            bordered
            size="small"
            column={2}
            items={usage.metrics.map((metric) => ({
              key: metric.key,
              label: metric.label,
              children: (
                <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                  <strong>{formatMetric(metric)}</strong>
                  {metric.detail ? (
                    <Typography.Paragraph type="secondary" className="!mb-0 !mt-1">
                      {metric.detail}
                    </Typography.Paragraph>
                  ) : null}
                </div>
              ),
            }))}
          />
        ) : null}
        {usage?.storage ? <PostgresCapacityPanel capacity={usage.storage} /> : null}
        {usage?.notes.map((note, index) => (
          <Typography.Paragraph key={index} type="secondary" className="!mb-0">
            {note}
          </Typography.Paragraph>
        ))}
      </div>
    </ActionDialog>
  );
}

function formatMetric(metric: InfrastructureMetric): string {
  if (metric.value === null) return "暂无数据";
  if (typeof metric.value === "boolean") return metric.value ? "是" : "否";
  if (typeof metric.value !== "number") return metric.value;
  if (metric.unit === "bytes")
    return metric.value >= 1024 ** 3
      ? formatDiskBytes(metric.value)
      : formatArtifactBytes(metric.value);
  if (metric.unit === "percent") return `${metric.value.toFixed(2)}%`;
  if (metric.unit === "seconds") return `${metric.value.toLocaleString("zh-CN")} 秒`;
  if (metric.unit === "milliseconds") return `${metric.value.toLocaleString("zh-CN")} ms`;
  return metric.value.toLocaleString("zh-CN");
}
