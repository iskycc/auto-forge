"use client";

import { useEffect, useState } from "react";
import { Table as AntTable, Tag, Tooltip } from "antd";
import { Gauge, RefreshCw, X } from "lucide-react";
import { concurrencyDiagnosticsSchema, type ConcurrencyDiagnostics } from "@autoforge/contracts";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";
import { LoadingState } from "./loading-state";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";

type Node = ConcurrencyDiagnostics["nodes"][number];
function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
}

export function ConcurrencyDiagnosticsDialog({
  batchId,
  onClose,
}: {
  batchId: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<ConcurrencyDiagnostics | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(new Error("诊断读取超时，请重试。")),
      10_000,
    );
    let active = true;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/v1/run-batches/${encodeURIComponent(batchId)}/concurrency-diagnostics`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, "读取并发诊断失败，请重试。"));
        const next = concurrencyDiagnosticsSchema.parse(await response.json());
        if (active) setResult(next);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "读取并发诊断失败，请重试。");
      } finally {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [batchId, revision]);
  return (
    <Dialog
      open
      title="并发诊断"
      onClose={onClose}
      className="grid max-h-[86vh] w-[min(1100px,_calc(100vw_-_64px))] grid-rows-[auto_minmax(0,_1fr)_auto] overflow-hidden rounded-xl border border-border bg-card shadow-lg"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <strong className="inline-flex items-center gap-2">
          <Gauge size={18} />
          并发诊断
        </strong>
        <Button variant="ghost" aria-label="关闭并发诊断" onClick={onClose}>
          <X size={16} />
        </Button>
      </header>
      <div className="grid min-h-0 min-w-0 gap-4 overflow-auto p-5">
        <p className="m-0 text-sm text-muted-foreground">
          查看未达并发上限的原因。按需读取当前调度条件，不会触发执行或调整并发。
        </p>
        {error ? (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        ) : null}
        {loading && !result ? <LoadingState label="正在读取并发诊断…" /> : null}
        {result ? (
          <>
            <div
              className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-muted/30 p-3"
              aria-label="并发诊断概览"
            >
              <Metric
                label="执行中 / 任务上限"
                value={`${result.runningRuns} / ${result.targetConcurrency ?? "未配置"}`}
              />
              <Metric label="已分配待领取" value={result.assignedRuns} />
              <Metric label="可调度排队用例" value={result.readyRuns} />
              <Metric
                label="项目在途 / 额度"
                value={`${result.projectActiveRuns} / ${result.projectMaximumConcurrency}`}
              />
              <Metric label="节点可增槽位" value={result.availableNodeSlots} />
              <Metric label="等待后续轮次" value={result.heldRuns} />
            </div>
            <Notice tone="info" role="status">
              <strong>{error ? "上次成功采样结论" : "本次采样结论"}</strong>
              <ul className="my-2 grid gap-1 pl-5">
                {result.reasons.map((reason) => (
                  <li key={reason.code}>{reason.message}</li>
                ))}
              </ul>
              <span className="text-xs">
                采样时间 {formatLocalDateTime(result.sampledAt)}
                ；执行中与待领取共同占用任务并发额度。数据在执行过程中可能变化，刷新后重新核验。
              </span>
            </Notice>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              准入阈值：CPU ≤ {result.thresholds.maximumCpuUtilizationPercent}% · 内存 ≤{" "}
              {result.thresholds.maximumMemoryUtilizationPercent}% · 每 CPU 负载 ≤{" "}
              {result.thresholds.maximumLoadPerCpu} · 指标有效期 {result.metricsMaximumAgeSeconds}{" "}
              秒。
              内存保留系统预算，未启动用例预留完整上限；已运行用例只补足尚可能增长的内存，避免重复计入实测占用。旧
              Agent
              或无可靠采集时仍完整预留。诊断以持久化占用和最近心跳计算，实时领取请求还会校正心跳槽位滞后。
              实际补位还受任务上限、项目额度和剩余用例数约束。
            </p>
            <AntTable<Node>
              size="small"
              rowKey="id"
              dataSource={result.nodes}
              loading={loading}
              pagination={{ pageSize: 5, showSizeChanger: false, hideOnSinglePage: true }}
              scroll={{ x: 940 }}
              columns={[
                {
                  title: "执行节点",
                  dataIndex: "name",
                  width: 170,
                  render: (name: string) => (
                    <Tooltip title={name} trigger={["hover", "focus"]}>
                      <strong tabIndex={0} className="line-clamp-2 [overflow-wrap:anywhere]">
                        {name}
                      </strong>
                    </Tooltip>
                  ),
                },
                {
                  title: "并发占用",
                  width: 155,
                  render: (_, node) => (
                    <div className="grid gap-1 text-xs">
                      <span>
                        本任务 {node.batchReservedSlots} · 其他任务 {node.otherReservedSlots}
                      </span>
                      <span className="text-muted-foreground">
                        上报忙碌 {node.reportedBusySlots} / {node.maxConcurrency}
                      </span>
                      <Tag color={node.availableSlots ? "success" : "default"}>
                        可增 {node.availableSlots}
                      </Tag>
                    </div>
                  ),
                },
                {
                  title: "资源与内存预算",
                  width: 265,
                  render: (_, node) => <NodeResources node={node} />,
                },
                {
                  title: "当前影响因素",
                  width: 350,
                  render: (_, node) =>
                    node.reasons.length ? (
                      <ul className="m-0 grid gap-1 pl-4 text-xs [overflow-wrap:anywhere]">
                        {node.reasons.map((reason) => (
                          <li key={reason.code}>{reason.message}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        当前准入条件满足，等待共同补位
                      </span>
                    ),
                },
              ]}
            />
            {result.omittedNodes ? (
              <Notice tone="warning">
                仅展示前 64 个节点，另有 {result.omittedNodes} 个历史节点未纳入本次节点诊断。
              </Notice>
            ) : null}
          </>
        ) : null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button
          variant="secondary"
          onClick={() => setRevision((value) => value + 1)}
          disabled={loading}
        >
          <RefreshCw size={15} />
          {loading ? "读取中…" : "刷新诊断"}
        </Button>
        <Button onClick={onClose}>关闭</Button>
      </footer>
    </Dialog>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="text-lg tabular-nums [overflow-wrap:anywhere]">{value}</strong>
    </div>
  );
}
function NodeResources({ node }: { node: Node }) {
  const metrics = node.metrics;
  return (
    <div className="grid gap-1 text-xs [overflow-wrap:anywhere]">
      {metrics ? (
        <>
          <span>
            CPU {metrics.cpuUtilizationPercent}% · 内存 {metrics.memoryUtilizationPercent}%
          </span>
          {metrics.memoryAvailableBytes !== undefined && metrics.memoryTotalBytes !== undefined ? (
            <span>
              可用 {gibibytes(metrics.memoryAvailableBytes)} / {gibibytes(metrics.memoryTotalBytes)}
            </span>
          ) : (
            <span className="text-muted-foreground">旧 Agent 未上报绝对内存</span>
          )}
          <span className="text-muted-foreground">
            指标 {formatLocalDateTime(metrics.observedAt)}
          </span>
        </>
      ) : (
        <span>暂无完整资源指标</span>
      )}
      <span>
        槽位可增 {node.concurrencyAvailableSlots} · 内存可增{" "}
        {node.memoryAvailableSlots ?? "未启用预留"}
      </span>
      {node.systemMemoryReserveBytes !== null ? (
        <span className="text-muted-foreground">
          系统保留 {gibibytes(node.systemMemoryReserveBytes)} · 每例{" "}
          {gibibytes(node.memoryPerAttemptBytes)}
        </span>
      ) : null}
      {node.memoryReservedGrowthBytes !== null && node.memoryReservedGrowthBytes !== undefined ? (
        <span className="text-muted-foreground">
          增长预留 {gibibytes(node.memoryReservedGrowthBytes)} · 已计入{" "}
          {gibibytes(node.memoryExecutionCreditBytes ?? 0)}
        </span>
      ) : null}
    </div>
  );
}
