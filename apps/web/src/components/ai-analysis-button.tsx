"use client";
import { Alert, Button, Empty, Modal, Progress, Space, Table, Tag, Typography } from "antd";
import { RobotOutlined, PlusOutlined, MinusOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState, useRef } from "react";
import type { AiAnalysisView } from "@autoforge/contracts";
import { readApiErrorMessage } from "@/lib/client-api";
import { createClientIdempotencyKey } from "@/lib/client-idempotency-key";

const ACTIVE = new Set(["queued", "preparing", "analyzing", "summarizing"]);
const LABELS: Record<string, string> = {
  queued: "等待分配",
  preparing: "准备清单",
  analyzing: "正在分析",
  summarizing: "分组汇总",
  completed: "分析完成",
  partial: "部分完成",
  failed: "分析失败",
  cancelled: "已取消",
  collecting: "采集证据",
  ready: "等待分析",
  retry_wait: "退避重试",
  group_ready: "等待同栈分析",
  publishing: "回填组内建议",
  running: "正在分析",
};
export function AiAnalysisButton({
  batchId,
  attemptId,
  compact = false,
  iconOnly = false,
}: {
  batchId: string;
  attemptId?: string;
  compact?: boolean;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const requestEpoch = useRef(0);
  const pendingRequestKey = useRef<string | undefined>(undefined);
  const [view, setView] = useState<AiAnalysisView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [cursor, setCursor] = useState("");
  const [previous, setPrevious] = useState<string[]>([]);
  const jobStatus = view?.job.status;
  const read = useCallback(
    async (signal?: AbortSignal) => {
      const epoch = requestEpoch.current;
      const parameters = new URLSearchParams({
        batchId,
        limit: "10",
        ...(attemptId ? { attemptId } : {}),
        ...(cursor ? { after: cursor } : {}),
      });
      const response = await fetch(`/api/v1/ai-analysis?${parameters}`, {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "读取 AI 初析失败。"))!);
      const next = (await response.json()) as AiAnalysisView | null;
      if (epoch === requestEpoch.current) setView(next);
      return next;
    },
    [batchId, attemptId, cursor],
  );
  async function create() {
    requestEpoch.current += 1;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/v1/ai-analysis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          batchId,
          ...(attemptId ? { attemptId } : {}),
          requestKey:
            pendingRequestKey.current ?? (pendingRequestKey.current = createClientIdempotencyKey()),
        }),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "发起 AI 初析失败。"))!);
      const accepted = (await response.json()) as AiAnalysisView["job"];
      pendingRequestKey.current = undefined;
      setView({ job: accepted, items: [] });
      setCursor("");
      setPrevious([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发起失败。");
    } finally {
      setPending(false);
    }
  }
  async function show() {
    setOpen(true);
    setError("");
    setPending(true);
    try {
      const existing = await read();
      if (!existing) await create();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取失败。");
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    if (open)
      void read().catch((cause) => setError(cause instanceof Error ? cause.message : "读取失败。"));
  }, [open, read]);
  useEffect(() => {
    if (!open || !jobStatus || !ACTIVE.has(jobStatus)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.visibilityState === "visible") await read(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "进度更新失败。");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, jobStatus, read]);
  const job = view?.job;
  async function cancel() {
    if (!job) return;
    setPending(true);
    try {
      const response = await fetch("/api/v1/ai-analysis", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId, jobId: job.id }),
      });
      if (!response.ok) throw new Error((await readApiErrorMessage(response, "取消初析失败。"))!);
      await read();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消失败。");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button
        aria-label="AI 初步分析"
        size="middle"
        style={compact ? { paddingInline: 8 } : undefined}
        icon={<RobotOutlined />}
        onClick={() => void show()}
      >
        {iconOnly ? null : "AI 初步分析"}
      </Button>
      <Modal
        open={open}
        title={attemptId ? "用例 AI 初步分析" : "批次 AI 初步分析"}
        onCancel={() => setOpen(false)}
        width={920}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            {view ? (
              <Space wrap>
                <Button
                  disabled={!previous.length}
                  onClick={() => {
                    setCursor(previous.at(-1) ?? "");
                    setPrevious((current) => current.slice(0, -1));
                  }}
                >
                  上一页
                </Button>
                <Button
                  disabled={!view.nextCursor}
                  onClick={() => {
                    setPrevious((current) => [...current, cursor]);
                    setCursor(view.nextCursor ?? "");
                  }}
                >
                  下一页
                </Button>
                <Button onClick={() => void read().catch((cause) => setError(String(cause)))}>
                  刷新进度
                </Button>
              </Space>
            ) : (
              <span />
            )}
            <Space wrap>
              {job && ACTIVE.has(job.status) ? (
                <Button onClick={() => void cancel()} loading={pending}>
                  取消分析
                </Button>
              ) : (
                <Button type="primary" onClick={() => void create()} loading={pending}>
                  重新分析
                </Button>
              )}
              <Button onClick={() => setOpen(false)}>关闭</Button>
            </Space>
          </div>
        }
        styles={{ body: { maxHeight: "65vh", overflowY: "auto" } }}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%", minWidth: 0 }}>
          <Alert
            type="info"
            showIcon
            title="初步建议，待人工确认"
            description="模型仅能读取证据并提交 AI 结论。页面关闭不影响后台工作；等待限流或平台资源时会自动退避。"
          />
          <Typography.Text type="secondary">
            {attemptId
              ? "单例读取完整 stdout 业务日志，必要时分片细查；最终仅保留初步分类、原因与依据。"
              : "按堆栈归类，同栈不足 10 例时逐例读取 stdout 全文；达到 10 例时共用堆栈分析。"}
          </Typography.Text>
          {error ? <Alert type="error" title={error} showIcon /> : null}
          {job?.reason ? <Alert type="warning" title={job.reason} showIcon /> : null}
          {job ? (
            <>
              <Space wrap>
                <Tag
                  color={
                    job.status === "completed"
                      ? "success"
                      : job.status === "partial"
                        ? "warning"
                        : "processing"
                  }
                >
                  {LABELS[job.status] ?? job.status}
                </Tag>
                <Typography.Text>
                  处理 {job.completed} / {job.total} · 已采集 {job.prepared} · 异常或证据不足{" "}
                  {job.failed}
                </Typography.Text>
              </Space>
              <Progress
                percent={
                  job.total ? Math.min(100, Math.round((job.completed / job.total) * 100)) : 0
                }
                status={ACTIVE.has(job.status) ? "active" : "normal"}
              />
              <Table
                size="small"
                rowKey="id"
                loading={pending}
                dataSource={view.items}
                pagination={false}
                scroll={{ x: 700 }}
                expandable={{
                  expandIcon: ({ expanded, onExpand, record }) => (
                    <Button
                      type="text"
                      size="middle"
                      aria-label={expanded ? "收起完整初析" : "查看完整初析"}
                      icon={expanded ? <MinusOutlined /> : <PlusOutlined />}
                      onClick={(event) => onExpand(record, event)}
                    />
                  ),
                  expandedRowRender: (item) => (
                    <Typography.Paragraph
                      style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}
                    >
                      {item.conclusion ?? item.reason ?? "正在后台准备详细证据。"}
                    </Typography.Paragraph>
                  ),
                  rowExpandable: () => true,
                }}
                columns={[
                  { title: "用例", dataIndex: "displayName", width: 240, ellipsis: true },
                  {
                    title: "进度",
                    dataIndex: "status",
                    width: 120,
                    render: (value: string) => <Tag>{LABELS[value] ?? value}</Tag>,
                  },
                  {
                    title: "AI 初步建议",
                    dataIndex: "conclusion",
                    render: (value: string | null, item) => (
                      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                        <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0 }}>
                          {value ?? item.reason ?? "等待 Worker 处理"}
                        </Typography.Paragraph>
                        <Typography.Text type="secondary">展开查看完整结论</Typography.Text>
                      </div>
                    ),
                  },
                ]}
              />
            </>
          ) : (
            <Empty description={pending ? "正在读取初析记录…" : "尚无初析记录"} />
          )}
        </Space>
      </Modal>
    </>
  );
}
