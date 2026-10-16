"use client";

import { Descriptions, Empty, Space, Table, Tag, Typography } from "antd";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SingleCaseExecutionEntry } from "@autoforge/application";
import { Button } from "./ui";
import { ActionDialog } from "./action-dialog";
import { AttemptLogViewer } from "./attempt-log-viewer";
import {
  caseExecutionResultLabel,
  caseExecutionStatusLabel,
  singleCaseExecutionStatus,
} from "@/lib/case-execution-presentation";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { useConfirm, useToast } from "./ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";

export type SingleExecutionRecordRow = {
  id: string;
  sequenceNumber: number;
  createdAt: string;
  requestedBy?: { username: string; source: "local" | "ldap" };
  singleCase?: SingleCaseExecutionEntry;
};

export function SingleCaseExecutionTable({
  rows,
  canReadLogs,
  canRetryRuns,
  canTerminate,
}: {
  rows: SingleExecutionRecordRow[];
  canReadLogs: boolean;
  canRetryRuns: boolean;
  canTerminate: boolean;
}) {
  const [resultId, setResultId] = useState<string>();
  const result = rows.find((row) => row.id === resultId);
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [terminating, setTerminating] = useState<string>();
  const [refreshing, startRefresh] = useTransition();
  const active = rows.some(
    (row) => !row.singleCase || ["queued", "assigned", "running"].includes(row.singleCase.status),
  );
  useEffect(() => {
    if (!active || refreshing) return;
    const timer = window.setTimeout(() => {
      if (!document.hidden) startRefresh(() => router.refresh());
    }, 3_000);
    const resume = () => {
      if (!document.hidden) startRefresh(() => router.refresh());
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [active, refreshing, router, rows]);
  const [log, setLog] = useState<NonNullable<SingleCaseExecutionEntry["attempt"]>>();
  const status = (row: SingleExecutionRecordRow) =>
    singleCaseExecutionStatus(row.singleCase?.status, row.singleCase?.attempt?.outcome);
  async function terminate(row: SingleExecutionRecordRow) {
    if (
      !(await confirm({
        title: "终止单用例执行？",
        description:
          "执行中的用例将被强行停止，环境可能残留脏数据，请确认后检查和清理。已保存的执行记录和日志会保留。",
        confirmLabel: "终止执行",
        tone: "danger",
      }))
    )
      return;
    setTerminating(row.id);
    try {
      const response = await fetch(
        row.singleCase
          ? `/api/v1/execution-runs/${encodeURIComponent(row.singleCase.runId)}/cancel`
          : `/api/v1/run-batches/${encodeURIComponent(row.id)}/terminate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "操作人从单用例执行列表终止执行。" }),
        },
      );
      if (!response.ok) throw new Error(await readApiErrorMessage(response, "终止执行失败。"));
      startRefresh(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "终止执行失败。");
    } finally {
      setTerminating(undefined);
    }
  }
  return (
    <>
      <div className="flex items-center justify-between gap-3 pb-3">
        <Typography.Text type="secondary">
          {active ? "执行中的记录自动更新" : "结果与日志按执行记录保留"} · 可横向滚动查看全部列
        </Typography.Text>
        <Button
          size="compact"
          disabled={refreshing}
          onClick={() => startRefresh(() => router.refresh())}
        >
          刷新记录
        </Button>
      </div>
      <Table<SingleExecutionRecordRow>
        rowKey="id"
        dataSource={rows}
        pagination={false}
        size="middle"
        scroll={{ x: 1050 }}
        locale={{ emptyText: <Empty description="暂无单用例执行记录" /> }}
        columns={[
          {
            title: "编号",
            width: 90,
            render: (_, row) => (
              <span className="tabular-nums" title={row.id}>
                #{row.sequenceNumber}
              </span>
            ),
          },
          {
            title: "用例",
            width: 250,
            render: (_, row) => (
              <div className="grid min-w-0 gap-1">
                <Typography.Text strong ellipsis={{ tooltip: row.singleCase?.displayName }}>
                  {row.singleCase?.displayName ?? "等待执行快照"}
                </Typography.Text>
                <Typography.Text type="secondary" ellipsis={{ tooltip: row.singleCase?.className }}>
                  {row.singleCase?.className ?? "—"}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: "类型",
            width: 90,
            render: (_, row) => (
              <Tag>{row.singleCase?.caseType === "ddt" ? "DDT" : "普通用例"}</Tag>
            ),
          },
          {
            title: "执行结果",
            width: 115,
            render: (_, row) => (
              <Tag
                color={
                  status(row) === "succeeded"
                    ? "success"
                    : ["failed", "timed_out"].includes(status(row))
                      ? "error"
                      : "default"
                }
              >
                {caseExecutionStatusLabel(status(row))}
              </Tag>
            ),
          },
          {
            title: "拉起人",
            width: 125,
            ellipsis: true,
            render: (_, row) => row.requestedBy?.username ?? "未记录",
          },
          {
            title: "开始时间",
            width: 180,
            render: (_, row) => (
              <span className="whitespace-nowrap tabular-nums">
                {formatPlatformDateTime(row.singleCase?.attempt?.startedAt ?? row.createdAt)}
              </span>
            ),
          },
          {
            title: "操作",
            width: 190,
            fixed: "right",
            render: (_, row) => (
              <Space wrap={false}>
                <Button size="compact" onClick={() => setResultId(row.id)}>
                  结果
                </Button>
                <Button
                  size="compact"
                  disabled={!canReadLogs || !row.singleCase?.attempt}
                  onClick={() => setLog(row.singleCase?.attempt ?? undefined)}
                >
                  日志
                </Button>
                {canTerminate &&
                (!row.singleCase ||
                  ["queued", "assigned", "running"].includes(row.singleCase.status)) ? (
                  <Button
                    size="compact"
                    variant="danger"
                    disabled={Boolean(terminating)}
                    onClick={() => void terminate(row)}
                  >
                    终止
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      {result ? (
        <ActionDialog
          open
          title={`单用例执行结果 #${result.sequenceNumber}`}
          onClose={() => setResultId(undefined)}
          className="w-[min(640px,_calc(100dvw_-_40px))]"
          footer={<Button onClick={() => setResultId(undefined)}>关闭</Button>}
        >
          <Descriptions
            bordered
            column={1}
            size="small"
            className="[&_.ant-descriptions-item-content]:break-words"
          >
            <Descriptions.Item label="用例">
              {result.singleCase?.displayName ?? "—"}
            </Descriptions.Item>
            <Descriptions.Item label="执行类">
              {result.singleCase?.className ?? "—"}
            </Descriptions.Item>
            <Descriptions.Item label="执行结果">
              {caseExecutionStatusLabel(status(result))}
            </Descriptions.Item>
            <Descriptions.Item label="结果说明">
              {caseExecutionResultLabel(result.singleCase?.attempt?.resultCode)}
            </Descriptions.Item>
            <Descriptions.Item label="结果码">
              {result.singleCase?.attempt?.resultCode ?? "—"}
            </Descriptions.Item>
            <Descriptions.Item label="拉起人">
              {result.requestedBy?.username ?? "未记录"}
            </Descriptions.Item>
            <Descriptions.Item label="开始时间">
              {result.singleCase?.attempt?.startedAt
                ? formatPlatformDateTime(result.singleCase.attempt.startedAt)
                : "尚未开始"}
            </Descriptions.Item>
            <Descriptions.Item label="结束时间">
              {result.singleCase?.attempt?.finishedAt
                ? formatPlatformDateTime(result.singleCase.attempt.finishedAt)
                : "尚未结束"}
            </Descriptions.Item>
          </Descriptions>
        </ActionDialog>
      ) : null}
      {log ? (
        <AttemptLogViewer
          attemptId={log.id}
          attemptStatus={log.status}
          canReadLogs={canReadLogs}
          canRetryRuns={canRetryRuns}
          onClose={() => setLog(undefined)}
        />
      ) : null}
    </>
  );
}
