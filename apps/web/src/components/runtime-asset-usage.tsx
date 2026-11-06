"use client";

import { Alert, Empty, Spin, Table, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { runtimeAssetUsagePageSchema, type RuntimeAssetUsagePage } from "@autoforge/contracts";
import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

/** Mounted only for an expanded runtime archive. Other files never issue usage queries. */
export function RuntimeAssetUsage({ runtimeAssetId }: { runtimeAssetId: string }) {
  const [cursors, setCursors] = useState<string[]>([""]);
  const [page, setPage] = useState<RuntimeAssetUsagePage>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const cursor = cursors.at(-1)!;

  function navigate(nextCursors: string[]) {
    setLoading(true);
    setError("");
    setCursors(nextCursors);
  }

  useEffect(() => {
    const abort = new AbortController();
    const parameters = new URLSearchParams({ runtimeAssetId, limit: "20" });
    if (cursor) parameters.set("cursor", cursor);
    void (async () => {
      const response = await fetch(`/api/v1/settings/storage/runtime-asset-usage?${parameters}`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        cache: "no-store",
      });
      const message = await readApiErrorMessage(response, "读取项目与版本引用失败。");
      if (message) throw new Error(message);
      const result = runtimeAssetUsagePageSchema.parse(await response.json());
      if (!abort.signal.aborted) setPage(result);
    })()
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取项目与版本引用失败。");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [runtimeAssetId, cursor, refresh]);

  return (
    <section
      aria-label="项目与版本引用"
      aria-busy={loading}
      className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">使用项目与版本</strong>
        <Button
          type="button"
          size="compact"
          disabled={loading}
          onClick={() => {
            navigate([""]);
            setRefresh((value) => value + 1);
          }}
        >
          刷新引用
        </Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        显示当前资源绑定，包含已归档的项目与版本；历史执行快照不计入此清单。
      </p>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      <Spin spinning={loading}>
        <Table
          size="small"
          tableLayout="fixed"
          rowKey="referenceId"
          dataSource={page?.items ?? []}
          pagination={false}
          scroll={{ y: "clamp(192px, 40vh, 360px)" }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  loading
                    ? "正在读取使用范围…"
                    : error
                      ? "引用暂时无法读取"
                      : "当前没有项目或版本引用此资源"
                }
              />
            ),
          }}
          columns={[
            {
              title: "项目",
              key: "project",
              width: "50%",
              render: (_, reference) => (
                <div className="grid min-w-0 gap-1">
                  <Typography.Paragraph
                    className="!mb-0"
                    ellipsis={{ rows: 2, tooltip: reference.projectName }}
                  >
                    {reference.projectName}
                  </Typography.Paragraph>
                  {reference.projectArchived ? <Tag className="m-0 w-fit">项目已归档</Tag> : null}
                </div>
              ),
            },
            {
              title: "版本",
              key: "version",
              width: "50%",
              render: (_, reference) => (
                <div className="grid min-w-0 gap-1">
                  <Typography.Paragraph
                    className="!mb-0"
                    ellipsis={{ rows: 2, tooltip: reference.projectVersionName }}
                  >
                    {reference.projectVersionName ?? "项目默认（历史配置）"}
                  </Typography.Paragraph>
                  {reference.versionStatus === "archived" ? (
                    <Tag className="m-0 w-fit">版本已归档</Tag>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </Spin>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          第 {cursors.length} 页 · 本页 {page?.items.length ?? 0} 项
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="compact"
            disabled={loading || cursors.length === 1}
            onClick={() => navigate(cursors.slice(0, -1))}
          >
            上一页
          </Button>
          <Button
            type="button"
            size="compact"
            disabled={loading || Boolean(error) || !page?.nextCursor}
            onClick={() => navigate([...cursors, page!.nextCursor!])}
          >
            下一页
          </Button>
        </div>
      </div>
    </section>
  );
}
