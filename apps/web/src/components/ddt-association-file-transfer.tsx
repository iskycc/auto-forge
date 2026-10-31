"use client";
import { useEffect, useRef, useState } from "react";
import { Alert, Flex, Progress, Table, Typography, Upload } from "antd";
import { Download, FileSpreadsheet, Upload as UploadIcon } from "lucide-react";
import {
  DDT_ASSOCIATION_IMPORT_MAXIMUM_BYTES,
  ddtAssociationImportPreviewSchema,
  type DdtAssociationImportPreview,
  type DdtAssociationImportProgress,
} from "@autoforge/contracts";
import { ApiClientError, throwApiErrorResponse } from "@/lib/client-api";
import { parseExportFilename } from "@/lib/run-batch-export";
import { readAssociationImportProgress } from "@/lib/ddt-association-client";
import { clearBrowserSnapshots } from "@/lib/browser-read-cache";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";

export function DdtAssociationFileTransfer({
  url,
  canManage,
  onImported,
}: {
  url: string;
  canManage: boolean;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<DdtAssociationImportPreview>();
  const [progress, setProgress] = useState<DdtAssociationImportProgress>();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [working, setWorking] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const endpoint = (path: string, extra: Record<string, string> = {}) => {
    const target = new URL(url, window.location.origin);
    target.pathname += `/${path}`;
    for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);
    return target.toString();
  };
  const message = (cause: unknown) =>
    cause instanceof Error ? cause.message : "关联配置表格处理失败，请重试。";
  async function download(template: boolean) {
    setWorking(template ? "正在生成模板…" : "正在导出配置…");
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(endpoint("export", { template: template ? "1" : "0" }), {
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      });
      if (!response.ok) await throwApiErrorResponse(response, "导出关联配置失败。");
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = parseExportFilename(response.headers.get("content-disposition"));
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      request.current = null;
      setWorking("");
    }
  }
  async function upload(action: "preview" | "import") {
    if (!file || (action === "import" && !preview)) return;
    const controller = new AbortController();
    request.current = controller;
    setWorking(action === "preview" ? "正在校验配置…" : "正在导入配置…");
    setError("");
    setSuccess("");
    setProgress(undefined);
    const form = new FormData();
    form.set("file", file);
    try {
      const response = await fetch(
        endpoint("import", {
          action,
          ...(action === "import" ? { fingerprint: preview!.fingerprint } : {}),
        }),
        {
          method: "POST",
          body: form,
          cache: "no-store",
          signal:
            action === "preview"
              ? AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
              : controller.signal,
        },
      );
      if (!response.ok) await throwApiErrorResponse(response, "处理关联配置失败。");
      if (action === "preview")
        setPreview(ddtAssociationImportPreviewSchema.parse(await response.json()));
      else {
        const result = await readAssociationImportProgress(response, setProgress);
        setSuccess(
          `导入完成：处理 ${result.processed} 项，变更 ${result.changed} 项，复用 ${result.unchanged} 项。`,
        );
        setPreview(undefined);
        setFile(undefined);
        setOpen(false);
      }
    } catch (cause) {
      setError(
        controller.signal.aborted
          ? "导入已停止。已保存的变更保留，请重新预览后继续。"
          : message(cause),
      );
      if (action === "import") {
        setPreview(undefined);
        if (cause instanceof ApiClientError) {
          const current = ddtAssociationImportPreviewSchema.safeParse(cause.details);
          if (current.success) setPreview(current.data);
        }
      }
    } finally {
      if (action === "import") {
        clearBrowserSnapshots();
        onImported();
      }
      request.current = null;
      setWorking("");
    }
  }
  return (
    <>
      <Flex wrap align="center" gap="small" className="mb-4" aria-label="SR 关联配置表格操作">
        {canManage ? (
          <Button
            type="button"
            variant="secondary"
            disabled={Boolean(working)}
            onClick={() => {
              setError("");
              setSuccess("");
              setOpen(true);
            }}
          >
            <UploadIcon size={15} />
            导入配置
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          disabled={Boolean(working)}
          onClick={() => void download(false)}
        >
          <Download size={15} />
          导出配置
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={Boolean(working)}
          onClick={() => void download(true)}
        >
          <FileSpreadsheet size={15} />
          下载模板
        </Button>
        <Typography.Text type="secondary">
          候选测试类、需求分类及全部 SR 关联，按当前阶段导入导出
        </Typography.Text>
        {!open && working ? <Typography.Text role="status">{working}</Typography.Text> : null}
      </Flex>
      {!open && error ? <Alert type="error" showIcon title={error} className="mb-4" /> : null}
      {success ? (
        <Alert type="success" showIcon title={success} className="mb-4" role="status" />
      ) : null}
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="导入 SR 关联配置"
        description="Excel 多 Sheet：候选测试类、分类执行类、SR需求分类、SR直接关联。保留工作表名称与首行表头。"
        closeDisabled={Boolean(working)}
        className="w-[min(880px,calc(100vw-3rem))]"
        footer={
          <Flex
            align="center"
            justify="space-between"
            gap="middle"
            wrap
            className="w-full px-6 py-4"
          >
            <Typography.Text type="secondary">
              {working || "先预览核对，确认后逐项保存。"}
            </Typography.Text>
            <Flex gap="small">
              {working === "正在导入配置…" ? (
                <Button type="button" variant="secondary" onClick={() => request.current?.abort()}>
                  停止导入
                </Button>
              ) : null}
              <Button
                type="button"
                disabled={!preview || preview.issueCount > 0 || Boolean(working)}
                onClick={() => void upload("import")}
              >
                确认导入
              </Button>
            </Flex>
          </Flex>
        }
      >
        <div className="grid min-w-0 gap-4">
          <Alert
            type="info"
            showIcon
            title="按名称合并覆盖，表中未列出的配置保留"
            description="测试类使用完整类路径；请先在目标阶段导入 TestNG JAR 和 DDT 用例。SR 分类或直接执行类留空表示解除关联，同一 SR 只能出现在一个关联工作表。此处不包含独立的 SR 标签。"
          />
          {error ? <Alert type="error" showIcon title={error} role="alert" /> : null}
          <Flex wrap align="center" gap="small">
            <Upload
              accept=".xlsx"
              showUploadList={false}
              disabled={Boolean(working)}
              beforeUpload={(selected) => {
                setPreview(undefined);
                setProgress(undefined);
                setError("");
                if (selected.size > DDT_ASSOCIATION_IMPORT_MAXIMUM_BYTES) {
                  setFile(undefined);
                  setError("配置文件不能超过 16 MiB。");
                } else setFile(selected);
                return Upload.LIST_IGNORE;
              }}
            >
              <Button type="button" variant="secondary" disabled={Boolean(working)}>
                <UploadIcon size={15} />
                选择表格
              </Button>
            </Upload>
            <Typography.Text className="min-w-0 max-w-80" ellipsis={{ tooltip: true }}>
              {file?.name ?? "XLSX 多 Sheet，最多 500,000 行、16 MiB"}
            </Typography.Text>
            <Button
              type="button"
              disabled={!file || Boolean(working)}
              onClick={() => void upload("preview")}
            >
              预览校验
            </Button>
          </Flex>
          {progress ? (
            <div role="status">
              <Progress
                percent={
                  progress.total ? Math.floor((progress.processed / progress.total) * 100) : 0
                }
              />
              <Typography.Text type="secondary">
                已处理 {progress.processed}/{progress.total} 项 · 变更 {progress.changed} 项 · 复用{" "}
                {progress.unchanged} 项
              </Typography.Text>
            </div>
          ) : null}
          {preview ? (
            <>
              <Alert
                type={preview.issueCount ? "warning" : "success"}
                showIcon
                title={`共 ${preview.rowCount} 行，${preview.issueCount} 项问题`}
                description={`候选测试类 ${preview.counts.range} · 分类执行类 ${preview.counts.categories} · SR需求分类 ${preview.counts.srCategories} · SR直接关联 ${preview.counts.srClasses}`}
              />
              {preview.issueCount ? (
                <Table
                  size="small"
                  rowKey={(row) => `${row.sheetName}:${row.rowNumber}:${row.reason}`}
                  dataSource={preview.issues}
                  pagination={{ pageSize: 8, showSizeChanger: false }}
                  scroll={{ x: 700 }}
                  columns={[
                    { title: "工作表", dataIndex: "sheetName", width: 120 },
                    { title: "行号", dataIndex: "rowNumber", width: 64 },
                    { title: "标识", dataIndex: "identifier", width: 150, ellipsis: true },
                    { title: "问题", dataIndex: "reason", width: 366 },
                  ]}
                />
              ) : (
                <Table
                  size="small"
                  rowKey={(row) => `${row.sheetName}:${row.rowNumber}`}
                  dataSource={preview.samples}
                  pagination={{ pageSize: 8, showSizeChanger: false }}
                  scroll={{ x: 700 }}
                  columns={[
                    { title: "工作表", dataIndex: "sheetName", width: 120 },
                    { title: "行号", dataIndex: "rowNumber", width: 64 },
                    {
                      title: "SR／分类／测试类",
                      width: 240,
                      ellipsis: true,
                      render: (_, row) =>
                        "srNum" in row
                          ? row.srNum
                          : "categoryName" in row
                            ? row.categoryName
                            : row.className,
                    },
                    {
                      title: "关联配置",
                      width: 276,
                      ellipsis: true,
                      render: (_, row) =>
                        row.section === "range"
                          ? "加入候选范围"
                          : row.section === "srCategories"
                            ? row.categoryName || "解除关联"
                            : row.className || "解除关联",
                    },
                  ]}
                />
              )}
              <Typography.Text type="secondary">
                {preview.issueCount
                  ? "问题列表最多显示 100 项；存在问题时不会开始导入。"
                  : "仅预览前 20 行，确认后导入全部行。中断后已保存的变更保留，可重新预览并继续。"}
              </Typography.Text>
            </>
          ) : null}
        </div>
      </ActionDialog>
    </>
  );
}
