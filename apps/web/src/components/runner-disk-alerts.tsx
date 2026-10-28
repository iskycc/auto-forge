"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Pagination, Popover, Tag, Tooltip, theme } from "antd";
import { HardDrive, TriangleAlert } from "lucide-react";
import { z } from "zod";
import { runnerDiskCapacitySchema } from "@autoforge/contracts";
import type { RunnerResourceSnapshot } from "@autoforge/domain";
import { readApiError } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import {
  formatDiskBytes,
  formatDiskPercent,
  isRunnerDiskLow,
  isRunnerDiskStale,
} from "@/lib/runner-disk";

const runnerDiskReadingSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["online", "offline", "disabled", "draining"]),
  resourceSnapshot: z
    .object({
      disk: runnerDiskCapacitySchema.optional(),
      observedAt: z.string().datetime(),
    })
    .optional(),
});
const runnerDiskReadingsSchema = z.object({ items: z.array(runnerDiskReadingSchema).max(500) });
type RunnerDiskReading = z.infer<typeof runnerDiskReadingSchema>;
const POLL_INTERVAL_MS = 30_000;
const WARNING_PAGE_SIZE = 5;

export function RunnerDiskStatus({ snapshot }: { snapshot: RunnerResourceSnapshot | undefined }) {
  const disk = snapshot?.disk;
  if (!disk) return <small>磁盘余量：未上报</small>;
  return (
    <Tooltip
      title={
        <span className="block max-h-64 overflow-auto wrap-anywhere">
          Agent 数据目录：{disk.path}
          <br />
          可用 {formatDiskBytes(disk.availableBytes)} / {formatDiskBytes(disk.totalBytes)}
        </span>
      }
    >
      <small className={isRunnerDiskLow(disk) ? "text-warning!" : undefined}>
        磁盘可用 {formatDiskPercent(disk)} · {formatDiskBytes(disk.availableBytes)}
        {isRunnerDiskLow(disk) ? " · 空间不足" : ""}
      </small>
    </Tooltip>
  );
}

export function RunnerDiskAlerts({
  initialRunners,
  observedAt,
  timeZone,
}: {
  initialRunners: RunnerDiskReading[];
  observedAt: string;
  timeZone: string;
}) {
  const { token } = theme.useToken();
  const [readings, setReadings] = useState(initialRunners);
  const [checkedAt, setCheckedAt] = useState(observedAt);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const schedule = () => {
      if (!disposed && !document.hidden) timer = setTimeout(() => void refresh(), POLL_INTERVAL_MS);
    };
    async function refresh() {
      if (disposed || document.hidden || request) return;
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch("/api/v1/runners?limit=500", {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        const failure = await readApiError(response, "磁盘状态更新失败，显示上次上报数据。");
        if (failure) throw failure;
        const result = runnerDiskReadingsSchema.parse(await response.json());
        if (!disposed && !controller.signal.aborted) {
          setReadings(result.items);
          setCheckedAt(new Date().toISOString());
          setError("");
        }
      } catch (failure) {
        if (!disposed && !controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "磁盘状态更新失败。");
      } finally {
        request = undefined;
        schedule();
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (document.hidden) request?.abort();
      else if (!request) void refresh();
      // An aborted request schedules its successor after completing cleanup.
    }
    schedule();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  const warnings = readings
    .filter((runner) => isRunnerDiskLow(runner.resourceSnapshot?.disk))
    .sort((left, right) => {
      const a = left.resourceSnapshot!.disk!;
      const b = right.resourceSnapshot!.disk!;
      return (
        a.availableBytes / a.totalBytes - b.availableBytes / b.totalBytes ||
        left.name.localeCompare(right.name)
      );
    });
  if (warnings.length === 0) return null;
  const currentPage = Math.min(page, Math.ceil(warnings.length / WARNING_PAGE_SIZE));
  const visible = warnings.slice(
    (currentPage - 1) * WARNING_PAGE_SIZE,
    currentPage * WARNING_PAGE_SIZE,
  );
  return (
    <Popover
      placement="topRight"
      trigger={["hover", "click"]}
      title={
        <span className="flex items-center gap-2">
          <TriangleAlert size={16} />
          节点磁盘空间不足 · {warnings.length} 台
        </span>
      }
      content={
        <section aria-label="节点磁盘空间提醒" className="w-96 max-w-[calc(100vw-64px)]">
          <p className="mb-3 text-xs text-muted-foreground">
            Agent 数据目录所在分区可用空间低于 20%。请检查工作目录、日志及缓存占用。
          </p>
          {error ? (
            <Alert
              type="warning"
              showIcon
              title="状态更新失败，保留上次上报"
              description={error}
              className="mb-3"
            />
          ) : null}
          <div
            className={`grid max-h-[45vh] gap-3 overflow-y-auto ${warnings.length > WARNING_PAGE_SIZE ? "h-[45vh] content-start" : ""}`}
          >
            {visible.map((runner) => {
              const snapshot = runner.resourceSnapshot!;
              const disk = snapshot.disk!;
              const stale = isRunnerDiskStale(runner.state, snapshot.observedAt, checkedAt);
              return (
                <article
                  key={runner.id}
                  className="rounded-lg border border-solid border-border bg-muted p-3"
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <a
                      className="min-w-0 font-semibold wrap-anywhere"
                      href={`/runners?query=${encodeURIComponent(runner.id)}`}
                    >
                      {runner.name}
                    </a>
                    <Tag color="warning" className="m-0! shrink-0">
                      可用 {formatDiskPercent(disk)}
                    </Tag>
                  </div>
                  <p className="my-1 text-sm">
                    {formatDiskBytes(disk.availableBytes)} / {formatDiskBytes(disk.totalBytes)}
                  </p>
                  <p className="m-0 text-xs text-muted-foreground wrap-anywhere">{disk.path}</p>
                  <p className="mb-0 mt-1 text-xs text-muted-foreground">
                    {stale ? "历史数据，请确认节点状态 · " : "采样 "}
                    <time dateTime={snapshot.observedAt} title={`UTC：${snapshot.observedAt}`}>
                      {formatPlatformDateTime(snapshot.observedAt, timeZone)}
                    </time>
                  </p>
                </article>
              );
            })}
          </div>
          {warnings.length > WARNING_PAGE_SIZE ? (
            <Pagination
              className="mt-3"
              size="small"
              current={currentPage}
              pageSize={WARNING_PAGE_SIZE}
              total={warnings.length}
              showSizeChanger={false}
              onChange={setPage}
            />
          ) : null}
          <p className="mb-0 mt-3 text-xs text-muted-foreground">
            覆盖节点列表全部分页与筛选，每 30 秒更新；未上报磁盘信息的节点不计入。
          </p>
        </section>
      }
    >
      <div className="fixed bottom-6 right-6 z-40">
        <Button
          className="shadow-sm"
          style={{
            color: token.colorWarningText,
            background: token.colorWarningBg,
            borderColor: token.colorWarningBorder,
            borderRadius: token.borderRadiusLG,
          }}
          icon={<HardDrive size={17} />}
          aria-label={`磁盘空间不足：${warnings.length} 台节点`}
        >
          磁盘预警 · {warnings.length} 台
        </Button>
      </div>
    </Popover>
  );
}
