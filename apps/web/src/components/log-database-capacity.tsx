"use client";

import { Alert, Button, Flex, Skeleton, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { postgresStorageCapacitySchema, type PostgresStorageCapacity } from "@autoforge/contracts";
import { readApiError } from "@/lib/client-api";
import { formatDiskBytes } from "@/lib/runner-disk";
import { ActionDialog } from "./action-dialog";
import { PostgresCapacityPanel } from "./postgres-capacity-panel";

export function LogDatabaseCapacity({
  databaseId,
  active,
}: {
  databaseId: string;
  active: boolean;
}) {
  const [capacity, setCapacity] = useState<PostgresStorageCapacity>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
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
          `/api/v1/settings/log-databases/${databaseId}/capacity${force ? "?refresh=1" : ""}`,
          {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          },
        );
        if (!response.ok) throw await readApiError(response, "读取日志库磁盘余量失败。");
        const value = postgresStorageCapacitySchema.parse(await response.json());
        if (!controller.signal.aborted) setCapacity(value);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取磁盘余量失败。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [databaseId],
  );
  useEffect(() => {
    const timer = active ? window.setTimeout(() => void refresh(), 0) : undefined;
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      pending.current?.abort();
    };
  }, [active, refresh]);
  return (
    <>
      <Flex gap="small" wrap align="center" className="!mt-2">
        <Typography.Text type="secondary">
          数据卷余量：
          {capacitySummary(capacity, loading, error)}
        </Typography.Text>
        <Button
          type="link"
          size="small"
          onClick={() => {
            setOpen(true);
            if (!capacity && !loading) void refresh();
          }}
        >
          查看容量
        </Button>
      </Flex>
      <ActionDialog
        open={open}
        title="日志库磁盘容量"
        description="读取 PostgreSQL 宿主机数据卷的磁盘采样；数据库大小和可用磁盘空间分别计算。"
        onClose={() => {
          pending.current?.abort();
          setLoading(false);
          setOpen(false);
        }}
        className="w-[min(760px,calc(100vw-3rem))]"
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Flex justify="end">
            <Button loading={loading} onClick={() => void refresh(true)}>
              刷新容量
            </Button>
          </Flex>
          {error ? <Alert type="error" showIcon title={error} /> : null}
          {!capacity && loading ? <Skeleton active /> : null}
          {capacity ? <PostgresCapacityPanel capacity={capacity} /> : null}
          <Typography.Paragraph type="secondary" className="!mb-0">
            新部署模板会在 PostgreSQL 容器内对 PGDATA
            所在文件系统采样；已有独立部署需更新采样健康检查。未采集时明确显示不可用，不使用主平台主机的空间代替。
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
