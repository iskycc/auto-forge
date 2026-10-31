"use client";

import { Alert, Flex, Progress, Statistic, Typography } from "antd";
import type { PostgresStorageCapacity } from "@autoforge/contracts";
import { formatDiskBytes } from "@/lib/runner-disk";

export function PostgresCapacityPanel({ capacity }: { capacity: PostgresStorageCapacity }) {
  const measured = capacity.capacityBytes !== undefined && capacity.availableBytes !== undefined;
  const availablePercent = measured
    ? (capacity.availableBytes! / capacity.capacityBytes!) * 100
    : undefined;
  const current = capacity.status === "available";
  const low = current && availablePercent !== undefined && availablePercent < 20;
  return (
    <div className="flex min-w-0 flex-col gap-3" aria-label="PostgreSQL 数据卷容量">
      <Alert
        showIcon
        type={low ? "warning" : current ? "info" : "warning"}
        title={
          current
            ? low
              ? "数据卷剩余空间不足 20%"
              : "数据库数据卷余量"
            : capacity.status === "stale"
              ? "磁盘采样已过期"
              : "磁盘余量暂不可用"
        }
        description={capacity.detail}
      />
      {measured ? (
        <>
          <Flex gap="large" justify="space-between" wrap>
            <Statistic
              title={current ? "当前可用空间" : "上次采样可用空间"}
              value={formatDiskBytes(capacity.availableBytes!)}
            />
            <Statistic title="数据卷总容量" value={formatDiskBytes(capacity.capacityBytes!)} />
            <Statistic
              title="可用比例"
              value={(Math.floor(availablePercent! * 100) / 100).toFixed(2)}
              suffix="%"
            />
          </Flex>
          <Progress
            percent={Math.round((100 - availablePercent!) * 100) / 100}
            status={low ? "exception" : "normal"}
            showInfo={false}
          />
          <Typography.Text type="secondary">
            已用／预留 {(100 - availablePercent!).toFixed(2)}%
          </Typography.Text>
        </>
      ) : null}
      {capacity.sampledAt ? (
        <Typography.Text type="secondary">
          磁盘采样：{new Date(capacity.sampledAt).toLocaleString("zh-CN")}（UTC {capacity.sampledAt}
          ）
        </Typography.Text>
      ) : null}
    </div>
  );
}
