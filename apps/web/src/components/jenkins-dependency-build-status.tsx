"use client";
import { Descriptions, Tag, Typography } from "antd";
import { ExternalLink } from "lucide-react";
import type { JenkinsDependencyBuild } from "@autoforge/contracts";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

export function JenkinsDependencyBuildStatus({
  build,
  timeZone,
}: {
  build: JenkinsDependencyBuild;
  timeZone: string;
}) {
  const labels: Record<JenkinsDependencyBuild["status"], { label: string; color: string }> = {
    submitting: { label: "正在提交", color: "processing" },
    queued: { label: "排队中", color: "processing" },
    running: { label: "构建中", color: "processing" },
    succeeded: { label: "构建成功", color: "success" },
    failed: { label: "构建失败", color: "error" },
    cancelled: { label: "已取消", color: "default" },
    unknown: { label: "提交待核对", color: "warning" },
    closed: { label: "已人工核对", color: "default" },
  };
  const state = labels[build.status];
  return (
    <Descriptions
      size="small"
      bordered
      column={2}
      styles={{ label: { whiteSpace: "nowrap" } }}
      items={[
        {
          key: "status",
          label: "当前状态",
          children: <Tag color={state.color}>{state.label}</Tag>,
        },
        {
          key: "number",
          label: "构建编号",
          children: build.buildUrl ? (
            <Typography.Link href={build.buildUrl} target="_blank" rel="noopener noreferrer">
              #{build.buildNumber} <ExternalLink size={12} className="inline" />
            </Typography.Link>
          ) : (
            "等待分配"
          ),
        },
        {
          key: "actor",
          label: "发起人",
          children: <span className="break-all">{build.triggeredBy}</span>,
        },
        {
          key: "time",
          label: "提交时间",
          children: formatPlatformDateTime(build.triggeredAt, timeZone),
        },
        {
          key: "message",
          label: "状态说明",
          span: 2,
          children: build.message || "等待 Jenkins 返回状态",
        },
        ...(build.finishedAt
          ? [
              {
                key: "finished",
                label: "结束时间",
                span: 2,
                children: formatPlatformDateTime(build.finishedAt, timeZone),
              },
            ]
          : []),
      ]}
    />
  );
}
