"use client";

import { useEffect, useState } from "react";
import { Alert, Collapse, Empty, Pagination, Skeleton, Tag } from "antd";
import type { RunBatchCasePage } from "@autoforge/application";
import type { RunAttempt } from "@autoforge/domain";
import type { ExecutionBatchView } from "@/lib/execution-batch-view";
import { loadExecutionCasePage } from "@/lib/execution-case-page-client";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui";

const TIMEOUT_LABELS: Readonly<Record<string, string>> = {
  ASSIGNMENT_CLAIM_TIMEOUT: "领取超时",
  LEASE_EXPIRED: "租约过期",
  EXECUTION_TIMEOUT: "执行超时",
  ADAPTER_CASE_TIMEOUT: "测试类执行超时",
  UPLOAD_TIMEOUT: "结果上传超时",
};
const PAGE_SIZE = 10;

export function RunnerTimeoutDialog({
  batch,
  round,
  runnerId,
  runnerName,
  canReadLogs,
  onOpenLogs,
  onClose,
}: {
  batch: ExecutionBatchView;
  round: number;
  runnerId: string;
  runnerName: string;
  canReadLogs: boolean;
  onOpenLogs: (attempt: RunAttempt) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    result?: RunBatchCasePage;
    error?: string;
  }>();
  const parameters = new URLSearchParams({
    cached: "1",
    scope: "attempts",
    status: "timed_out",
    runnerId,
    executionRound: String(round),
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (batch.accessToken) parameters.set("access_token", batch.accessToken);
  const url = `/api/v1/run-batches/${encodeURIComponent(batch.id)}/cases?${parameters}`;
  const revision = `${batch.updatedAt}\u0000${batch.statistics?.generation ?? ""}`;
  const key = `${url}\u0000${revision}\u0000${retry}`;
  const current = loaded?.key === key ? loaded : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void loadExecutionCasePage(url, revision, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setLoaded({ key, result });
      },
      (failure: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            error: failure instanceof Error ? failure.message : "读取超时记录失败。",
          });
      },
    );
    return () => controller.abort();
  }, [url, revision, key]);
  return (
    <ActionDialog
      open
      title="执行机超时记录"
      description={`第 ${round} 轮 · ${runnerName}`}
      className="w-[min(960px,calc(100vw_-_64px))]"
      onClose={onClose}
    >
      <div className="grid min-w-0 gap-4">
        <Alert
          type="info"
          showIcon
          title="逐次保留超时记录，后续重调度成功也不会覆盖。原因来自平台或执行机的原始上报。"
        />
        {!current ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : current.error ? (
          <Alert
            type="error"
            showIcon
            title={current.error}
            action={<Button onClick={() => setRetry((value) => value + 1)}>重试</Button>}
          />
        ) : current.result?.items.length ? (
          <Collapse
            defaultActiveKey={
              current.result.items[0]?.attempt?.id ? [current.result.items[0].attempt.id] : []
            }
            items={current.result.items.flatMap(({ run, attempt }) =>
              attempt
                ? [
                    {
                      key: attempt.id,
                      label: (
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <Tag color="warning">
                            {TIMEOUT_LABELS[attempt.resultCode ?? ""] ?? "超时"}
                          </Tag>
                          <strong className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
                            {run.displayName}
                          </strong>
                          <span className="text-xs text-muted-foreground">
                            第 {attempt.attemptNumber} 次尝试
                          </span>
                        </div>
                      ),
                      children: (
                        <div className="grid min-w-0 gap-3 text-sm">
                          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                            {run.className}
                          </span>
                          <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
                            <span>
                              开始：
                              {attempt.startedAt
                                ? formatLocalDateTime(attempt.startedAt)
                                : "未开始执行"}
                            </span>
                            <span>
                              超时：
                              {attempt.finishedAt
                                ? formatLocalDateTime(attempt.finishedAt)
                                : "未记录"}
                            </span>
                            <span className="[overflow-wrap:anywhere]">
                              原因码：{attempt.resultCode ?? "未记录"}
                            </span>
                          </div>
                          <p className="m-0 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 [overflow-wrap:anywhere]">
                            {attempt.resultSummary ||
                              "历史记录未提供详细原因，可进一步查看用例日志与调度日志。"}
                          </p>
                          {canReadLogs ? (
                            <div>
                              <Button size="compact" onClick={() => onOpenLogs(attempt)}>
                                查看用例日志
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ),
                    },
                  ]
                : [],
            )}
          />
        ) : (
          <Empty description="本轮该执行机暂无超时记录" />
        )}
        {current?.result ? (
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={current.result.total}
            showSizeChanger={false}
            showTotal={(total) => `共 ${total} 次超时`}
            onChange={setPage}
            className="flex flex-wrap justify-end"
          />
        ) : null}
      </div>
    </ActionDialog>
  );
}
