"use client";

import { Alert, Badge, Button, Flex, Skeleton, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LogDatabaseStatus, PostgresStorageCapacity } from "@autoforge/contracts";
import { formatDiskBytes } from "@/lib/runner-disk";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { logDatabaseStatusClient } from "@/lib/log-database-status-client";
import { ActionDialog } from "./action-dialog";
import { StorageMonitoringSettings } from "./storage-monitoring-settings";
import { PostgresCapacityPanel } from "./postgres-capacity-panel";

export function LogDatabaseCapacity({
  databaseId,
  canManage = false,
}: {
  databaseId: string;
  canManage?: boolean;
}) {
  const [status, setStatus] = useState<LogDatabaseStatus>();
  const capacity = status?.capacity;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const displayedCapacity: PostgresStorageCapacity | undefined =
    error && capacity?.status === "available"
      ? { ...capacity, status: "stale", detail: "页面刷新失败，当前仅显示上次磁盘采样值。" }
      : capacity;
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (force = false) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      try {
        const value = await logDatabaseStatusClient.read(databaseId, force, controller.signal);
        if (!controller.signal.aborted) setStatus(value);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取日志库监控失败。");
      } finally {
        if (pending.current === controller) pending.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [databaseId],
  );
  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    let running = false;
    async function inspect() {
      if (stopped || running || document.visibilityState !== "visible") return;
      if (timer !== undefined) window.clearTimeout(timer);
      running = true;
      await refresh();
      running = false;
      if (!stopped && document.visibilityState === "visible")
        timer = window.setTimeout(() => void inspect(), 30_000);
    }
    function visibilityChanged() {
      if (document.visibilityState === "visible") void inspect();
      else {
        if (timer !== undefined) window.clearTimeout(timer);
        pending.current?.abort();
        setLoading(false);
      }
    }
    timer = window.setTimeout(() => void inspect(), 0);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      pending.current?.abort();
    };
  }, [refresh]);
  const heartbeat = status?.heartbeat;
  const connection = heartbeatPresentation({ heartbeat, loading, error });
  return (
    <>
      <Flex gap="small" wrap align="center" className="!mt-2">
        <Tooltip title={connection.detail}>
          <span>
            <Badge status={connection.status} text={connection.text} />
          </span>
        </Tooltip>
        {heartbeat ? (
          <Typography.Text type="secondary" title={heartbeat.checkedAt}>
            最近心跳：{formatPlatformDateTime(heartbeat.checkedAt)} · {heartbeat.durationMs} ms
          </Typography.Text>
        ) : null}
      </Flex>
      <Flex gap="small" wrap align="center" className="!mt-2">
        <Typography.Text type="secondary">
          数据卷余量：
          {capacitySummary(displayedCapacity, loading, error)}
        </Typography.Text>
        <Button
          type="link"
          size="small"
          onClick={() => {
            setOpen(true);
            if (!loading) void refresh();
          }}
        >
          查看容量
        </Button>
      </Flex>
      <ActionDialog
        open={open}
        title="日志库磁盘容量"
        description="通过 Node Exporter 读取数据库数据卷余量；数据库大小与文件系统容量分别计算。"
        onClose={() => {
          setOpen(false);
        }}
        className="w-[min(760px,calc(100vw-3rem))]"
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Flex justify={canManage ? "space-between" : "end"} align="center" wrap gap="small">
            {canManage ? (
              <StorageMonitoringSettings
                target={{ kind: "logs", databaseId }}
                onSaved={() => refresh(true)}
              />
            ) : null}
            <Button loading={loading} onClick={() => void refresh(true)}>
              刷新容量
            </Button>
          </Flex>
          {error ? <Alert type="error" showIcon title={error} /> : null}
          {!capacity && loading ? <Skeleton active /> : null}
          {displayedCapacity ? <PostgresCapacityPanel capacity={displayedCapacity} /> : null}
          <Typography.Paragraph type="secondary" className="!mb-0">
            后台每分钟检查所有已登记日志库；页面自动显示当前写入库和历史库的采样。
            宿主机余量需配置对应 Node Exporter 地址与挂载点，不需要数据库文件权限或采样脚本。
          </Typography.Paragraph>
        </div>
      </ActionDialog>
    </>
  );
}

function capacitySummary(
  capacity: PostgresStorageCapacity | undefined,
  loading: boolean,
  error: string,
): string {
  if (capacity?.status === "available") return formatDiskBytes(capacity.availableBytes!);
  if (loading) return "读取中…";
  if (capacity)
    return {
      stale: "采样已过期",
      permission_denied: "无采样读取权限",
      unavailable: "采样暂不可用",
      not_configured: "待配置采样",
    }[capacity.status];
  return error ? "读取失败" : "尚未读取";
}

function heartbeatPresentation({
  heartbeat,
  loading,
  error,
}: {
  heartbeat: LogDatabaseStatus["heartbeat"] | undefined;
  loading: boolean;
  error: string;
}) {
  if (error) return { status: "warning" as const, text: "心跳待更新", detail: error };
  if (!heartbeat)
    return {
      status: "default" as const,
      text: loading ? "检查中…" : "待心跳",
      detail: "后台每分钟自动检查所有日志服务器。",
    };
  const detail = [
    heartbeat.detail,
    ...(heartbeat.errorCode ? [`错误码：${heartbeat.errorCode}`] : []),
    ...(heartbeat.lastSucceededAt
      ? [`最近正常：${formatPlatformDateTime(heartbeat.lastSucceededAt)}`]
      : []),
  ].join(" ");
  return {
    status: heartbeat.status === "healthy" ? ("success" as const) : ("error" as const),
    text: heartbeat.status === "healthy" ? "连接正常" : "连接异常",
    detail,
  };
}
