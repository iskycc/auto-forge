"use client";
import { Card, Collapse, Descriptions, Statistic, Typography } from "antd";
import type { SystemDiagnostic } from "@autoforge/contracts";
import { formatDiskBytes } from "@/lib/runner-disk";
export function SystemRuntimeInformation({ report }: { report: SystemDiagnostic }) {
  const information = report.information;
  if (!information) return null;
  const { traffic, execution } = information;
  const runtime = report.runtime;
  const strategy = {
    reserved: "阈值与内存预留",
    threshold: "仅内存使用率阈值",
    disabled: "关闭内存调度限制",
  }[execution.memoryAdmissionMode];
  return (
    <Card title="运行摘要" size="small" aria-label="运行摘要">
      <div className="grid grid-cols-3 gap-x-6 gap-y-4 min-[1440px]:grid-cols-6">
        <Statistic title="累计请求" value={traffic.requests} />
        <Statistic title="4xx 请求" value={traffic.clientErrors} />
        <Statistic title="5xx 请求" value={traffic.serverErrors} />
        <Statistic title="平均响应" value={traffic.meanDurationMs} suffix="ms" precision={1} />
        <Statistic
          title="事件循环延迟"
          value={traffic.sample?.eventLoopDelayMs ?? "—"}
          suffix="ms"
          precision={1}
        />
        <Statistic
          title="Web CPU 使用率"
          value={traffic.sample?.cpuUtilizationPercent ?? "—"}
          suffix="%"
          precision={1}
        />
      </div>
      <Typography.Paragraph type="secondary" className="!mb-4 !mt-4">
        请求计数自当前 Web 进程启动累计，平均值包含所有已完成请求；CPU
        为最近采样相对可用核数的比例。只读取内存计数，不扫描业务数据。信息快照最长复用 15 秒。
      </Typography.Paragraph>
      <Collapse
        size="small"
        items={[
          {
            key: "configuration",
            label: "执行配置与进程内存",
            children: (
              <Descriptions
                size="small"
                column={2}
                items={[
                  { key: "pid", label: "当前进程", children: runtime?.processId ?? "未知" },
                  { key: "v8", label: "V8 版本", children: runtime?.v8Version ?? "未知" },
                  {
                    key: "heap",
                    label: "已分配 JS 堆",
                    children:
                      runtime?.heapTotalBytes === undefined
                        ? "未知"
                        : formatDiskBytes(runtime.heapTotalBytes),
                  },
                  {
                    key: "external",
                    label: "堆外内存",
                    children:
                      runtime?.externalMemoryBytes === undefined
                        ? "未知"
                        : formatDiskBytes(runtime.externalMemoryBytes),
                  },
                  { key: "worker", label: "后台工作并发", children: execution.workerConcurrency },
                  {
                    key: "limit",
                    label: "项目在途上限",
                    children: execution.projectMaximumConcurrency,
                  },
                  {
                    key: "timeout",
                    label: "用例执行超时",
                    children: `${execution.caseTimeoutSeconds} 秒`,
                  },
                  { key: "memory", label: "内存调度策略", children: strategy },
                  {
                    key: "cpu",
                    label: "节点 CPU 阈值",
                    children: `${execution.maximumCpuPercent}%`,
                  },
                  {
                    key: "memoryThreshold",
                    label: "节点内存阈值",
                    children: `${execution.maximumMemoryPercent}%`,
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </Card>
  );
}
