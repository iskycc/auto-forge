"use client";

import {
  Alert,
  Button,
  Col,
  Empty,
  Progress,
  Row,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { aiAnalysisRuntimeSchema, type AiAnalysisRuntime } from "@autoforge/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { ActionDialog } from "./action-dialog";
import styles from "./system-diagnostics.styles";

const REFRESH_INTERVAL_MS = 5000;
type RuntimeJob = AiAnalysisRuntime["jobs"][number];
const PHASES = {
  plan: "划分候选组",
  classify: "堆栈初分",
  refine: "组内复核",
  rank: "汇总类别",
  publish: "发布组结论",
  individual: "独立分析",
} as const;

function jobStage(job: RuntimeJob) {
  if (job.acceptingFinalResults) return "接收最终结果";
  if (job.status === "queued") return "排队中";
  if (job.prepared + job.failed < job.total || job.status === "preparing") return "采集证据";
  if (job.status === "summarizing") return job.phase ? PHASES[job.phase] : "汇总结论";
  return "分析中";
}

export function SystemAiAnalysisRuntime() {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState<AiAnalysisRuntime>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (document.hidden || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/v1/settings/diagnostics/ai-analysis", {
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      });
      if (response.status === 401 || response.status === 403) setSample(undefined);
      if (!response.ok) throw new Error("AI 分析状态读取失败");
      const next = aiAnalysisRuntimeSchema.parse(await response.json());
      if (!controller.signal.aborted) {
        setSample(next);
        setFailed(false);
      }
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const poll = () => void refresh();
    const first = window.setTimeout(poll, 0);
    const interval = window.setInterval(poll, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
      request.current?.abort();
      request.current = null;
    };
  }, [refresh]);

  return (
    <section
      id="ai-analysis-runtime"
      className={`${styles.queueSummary} scroll-mt-24 border-l border-solid border-border pl-4`}
      aria-label="AI 初步分析"
    >
      <div className={styles.panelHeading}>
        <RobotOutlined aria-hidden />
        <h3>AI 初步分析</h3>
      </div>
      <div className={styles.queueStats}>
        <Statistic
          title="可见任务"
          value={sample?.jobs.length ?? "—"}
          suffix={sample?.hasMoreJobs ? "+" : undefined}
        />
        <Statistic
          title="请求占用"
          value={sample ? `${sample.activeRequests} / ${sample.concurrencyLimit}` : "—"}
        />
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-2">
        <Button type="link" className="!min-h-8 !px-0" onClick={() => setOpen(true)}>
          查看分析详情
        </Button>
        {failed ? (
          <Typography.Text type="warning">{sample ? "更新失败" : "读取失败"}</Typography.Text>
        ) : sample?.coolingUntil && sample.enabled ? (
          <Tag color="warning">限流冷却中</Tag>
        ) : sample && !sample.enabled ? (
          <Tag>已停用</Tag>
        ) : null}
      </div>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="AI 初步分析详情"
        closeLabel="关闭分析详情"
        className="w-[min(880px,calc(100vw-3rem))]"
        footer={
          <Button disabled={loading} onClick={() => void refresh()}>
            刷新进度
          </Button>
        }
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {failed ? (
            <Alert
              type="warning"
              showIcon
              title={sample ? "刷新失败，正在显示上次采样" : "暂时无法读取分析进度"}
            />
          ) : null}
          {loading && !sample && !failed ? <Skeleton active paragraph={{ rows: 3 }} /> : null}
          {sample ? (
            <>
              <Row gutter={[24, 12]} align="middle">
                <Col span={9}>
                  <Statistic
                    title="模型请求占用"
                    value={sample.activeRequests}
                    suffix={"/ " + sample.concurrencyLimit}
                  />
                  <Progress
                    percent={
                      sample.concurrencyLimit
                        ? Math.min(
                            100,
                            Math.round((sample.activeRequests * 100) / sample.concurrencyLimit),
                          )
                        : 0
                    }
                    showInfo={false}
                    aria-label="模型并发占用"
                  />
                </Col>
                <Col span={15}>
                  <Space orientation="vertical" size="small">
                    <Tag
                      color={
                        sample.enabled
                          ? sample.coolingUntil
                            ? "warning"
                            : "processing"
                          : "default"
                      }
                    >
                      {sample.enabled
                        ? sample.coolingUntil
                          ? "模型限流冷却中"
                          : "已启用"
                        : "已停用"}
                    </Tag>
                    {sample.coolingUntil ? (
                      <Typography.Text type="secondary">
                        冷却至 {formatPlatformDateTime(sample.coolingUntil)}
                      </Typography.Text>
                    ) : null}
                    <Typography.Text type="secondary">
                      更新于 {formatPlatformDateTime(sample.sampledAt)}
                    </Typography.Text>
                  </Space>
                </Col>
              </Row>
              <Table<RuntimeJob>
                rowKey="id"
                size="small"
                tableLayout="fixed"
                pagination={false}
                dataSource={sample.jobs}
                locale={{
                  emptyText: (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可见的分析任务" />
                  ),
                }}
                columns={[
                  {
                    title: "执行任务",
                    width: "32%",
                    render: (_, job) => (
                      <Space
                        orientation="vertical"
                        size={0}
                        style={{ display: "flex", minWidth: 0 }}
                      >
                        <Typography.Text
                          ellipsis={{ tooltip: job.taskName }}
                          style={{ display: "block" }}
                        >
                          <Link href={"/run-batches/" + encodeURIComponent(job.batchId)}>
                            {job.taskName}
                          </Link>
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          {job.sequenceNumber === null ? "" : "批次 #" + job.sequenceNumber + " · "}
                          {job.single ? "单例细查" : "批次初析"}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  { title: "阶段", width: "18%", render: (_, job) => <Tag>{jobStage(job)}</Tag> },
                  {
                    title: "用例进展",
                    width: "32%",
                    render: (_, job) => (
                      <Space orientation="vertical" size={0}>
                        <Typography.Text strong>
                          完成 {job.completed} / {job.total}
                        </Typography.Text>
                        <Typography.Text type="secondary">
                          采集 {job.prepared} · 复核 {job.reviewed}
                          {job.failed > 0 ? " · 异常 " + job.failed : ""}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: "占用请求",
                    width: "18%",
                    render: (_, job) => {
                      const { stack, group, individual } = job.requests;
                      return (
                        <Space orientation="vertical" size={0}>
                          <Typography.Text strong>{stack + group + individual}</Typography.Text>
                          <Typography.Text type="secondary">
                            {[
                              stack ? "初分 " + stack : "",
                              group ? "复核 " + group : "",
                              individual ? "独立 " + individual : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </Typography.Text>
                        </Space>
                      );
                    },
                  },
                ]}
              />
              {sample.hasMoreJobs ? (
                <Typography.Text type="secondary">显示最近更新的 20 项任务</Typography.Text>
              ) : null}
            </>
          ) : null}
        </Space>
      </ActionDialog>
    </section>
  );
}
