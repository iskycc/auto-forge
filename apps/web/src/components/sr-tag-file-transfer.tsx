"use client";
import { useEffect, useRef, useState } from "react";
import { Table, Upload, Typography } from "antd";
import { Download, FileSpreadsheet, Upload as UploadIcon } from "lucide-react";
import {
  SR_TAG_IMPORT_MAXIMUM_BYTES,
  srTagImportPreviewSchema,
  srTagImportResultSchema,
  type SrTagImportPreview,
  type SrTagImportResult,
} from "@autoforge/contracts";
import { requestDdtJson } from "@/lib/ddt-client";
import { throwApiErrorResponse, ApiClientError } from "@/lib/client-api";
import { parseExportFilename } from "@/lib/run-batch-export";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";

export function SrTagFileTransfer({
  url,
  canManage,
  disabled,
  open,
  onOpenChange,
  onBusyChange,
  onImported,
}: {
  url: string;
  canManage: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<SrTagImportPreview>();
  const [result, setResult] = useState<SrTagImportResult>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const endpoint = (path: string, extra = "") => {
    const parsed = new URL(url, window.location.origin);
    parsed.pathname += `/${path}`;
    return `${parsed}${extra ? `&${extra}` : ""}`;
  };
  function busy(label: string) {
    setWorking(label);
    onBusyChange(Boolean(label));
  }
  async function download(template: boolean) {
    busy(template ? "正在生成模板…" : "正在导出分类…");
    setError("");
    try {
      const response = await fetch(endpoint("export", template ? "template=1" : ""), {
        cache: "no-store",
      });
      if (!response.ok) await throwApiErrorResponse(response, "导出 SR 标签分类失败。");
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
      setError(errorMessage(cause));
    } finally {
      busy("");
    }
  }
  async function upload(action: "preview" | "import") {
    if (!file) return;
    const controller = new AbortController();
    request.current = controller;
    busy(action === "preview" ? "正在校验表格…" : "正在导入标签…");
    setError("");
    const form = new FormData();
    form.set("file", file);
    try {
      const response = await requestDdtJson<unknown>(endpoint("import", `action=${action}`), {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (action === "preview") setPreview(srTagImportPreviewSchema.parse(response));
      else {
        setResult(srTagImportResultSchema.parse(response));
        setPreview(undefined);
        setFile(undefined);
        onImported();
        onOpenChange(false);
      }
    } catch (cause) {
      setError(errorMessage(cause));
      if (action === "import") {
        onImported();
        if (cause instanceof ApiClientError) {
          const current = srTagImportPreviewSchema.safeParse(cause.details);
          if (current.success) setPreview(current.data);
        }
      }
    } finally {
      request.current = null;
      busy("");
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2" aria-label="SR 标签表格操作">
        {canManage ? (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || Boolean(working)}
            onClick={() => {
              setError("");
              setResult(undefined);
              onOpenChange(true);
            }}
          >
            <UploadIcon size={15} />
            导入分类
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || Boolean(working)}
          onClick={() => void download(false)}
        >
          <Download size={15} />
          导出分类
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || Boolean(working)}
          onClick={() => void download(true)}
        >
          <FileSpreadsheet size={15} />
          下载模板
        </Button>
        {working && !open ? (
          <span className="text-sm text-muted-foreground" role="status">
            {working}
          </span>
        ) : null}
      </div>
      {!open && error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
      {result ? (
        <Notice tone="success" role="status">
          导入完成：共 {result.rowCount} 行，新增 {result.createdCount} 条关联，复用{" "}
          {result.existingCount} 条已有关联。
        </Notice>
      ) : null}
      <ActionDialog
        open={open}
        onClose={() => onOpenChange(false)}
        title="导入 SR 标签分类"
        closeDisabled={Boolean(working)}
        className="w-[min(880px,calc(100vw-3rem))]"
        description="第一行填写表头 SR、标签；每行一个关联。同一 SR 可重复，相同 SR 与标签的组合不能重复。"
        footer={
          <div className="flex w-full items-center justify-between gap-3 px-6 py-4">
            <small className="text-muted-foreground" role="status">
              {working || "追加关联，保留已有标签；预览无问题后可导入。"}
            </small>
            <Button
              type="button"
              disabled={!preview || preview.issueCount > 0 || Boolean(working)}
              onClick={() => void upload("import")}
            >
              确认导入
            </Button>
          </div>
        }
      >
        <div className="grid min-w-0 gap-4">
          {error ? (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Upload
              accept=".xlsx,.xls,.xlsb,.csv,.ods"
              showUploadList={false}
              disabled={Boolean(working)}
              beforeUpload={(selected) => {
                setPreview(undefined);
                setError("");
                if (selected.size > SR_TAG_IMPORT_MAXIMUM_BYTES) {
                  setFile(undefined);
                  setError("表格不能超过 16 MiB。");
                  return Upload.LIST_IGNORE;
                }
                setFile(selected);
                return Upload.LIST_IGNORE;
              }}
            >
              <Button type="button" variant="secondary" disabled={Boolean(working)}>
                <UploadIcon size={15} />
                选择表格
              </Button>
            </Upload>
            <Typography.Text className="min-w-0 max-w-80" ellipsis={{ tooltip: true }}>
              {file?.name ?? "支持 Excel、CSV、ODS；最多 100,000 行、16 MiB"}
            </Typography.Text>
            <Button
              type="button"
              disabled={!file || Boolean(working)}
              onClick={() => void upload("preview")}
            >
              预览校验
            </Button>
          </div>
          {preview ? (
            <>
              <Notice tone={preview.issueCount ? "warning" : "success"} role="status">
                共 {preview.rowCount} 行，发现 {preview.issueCount} 项问题。
                {preview.issueCount
                  ? "请修正后重新选择文件，当前不会写入任何关联。"
                  : "校验通过，可以导入。"}
              </Notice>
              {preview.issueCount ? (
                <Table
                  size="small"
                  rowKey={(row) => `${row.sheetName}:${row.rowNumber}`}
                  dataSource={preview.issues}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  scroll={{ x: 680 }}
                  columns={[
                    { title: "工作表", dataIndex: "sheetName", width: 100, ellipsis: true },
                    { title: "行号", dataIndex: "rowNumber", width: 64 },
                    { title: "SR", dataIndex: "srNum", width: 140, ellipsis: true },
                    { title: "标签", dataIndex: "tagName", width: 120, ellipsis: true },
                    { title: "问题", dataIndex: "reason", width: 256 },
                  ]}
                />
              ) : (
                <Table
                  size="small"
                  rowKey={(row) => `${row.sheetName}:${row.rowNumber}`}
                  dataSource={preview.samples}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  scroll={{ x: 500 }}
                  columns={[
                    { title: "工作表", dataIndex: "sheetName", width: 110, ellipsis: true },
                    { title: "行号", dataIndex: "rowNumber", width: 64 },
                    { title: "SR", dataIndex: "srNum", width: 180, ellipsis: true },
                    { title: "标签", dataIndex: "tagName", width: 180, ellipsis: true },
                  ]}
                />
              )}
              <small className="text-muted-foreground">
                {preview.issueCount
                  ? "问题列表最多展示前 100 项。"
                  : "预览最多展示前 50 行，确认后导入全部校验通过的行。"}
              </small>
            </>
          ) : (
            <Notice tone="info">
              标签列每格填写一个标签。未知
              SR、空值、公式和重复组合会标出所在工作表及行号。导出分类包含本版本全部已保存的 SR
              标签关联，不受 SR 搜索条件影响。
            </Notice>
          )}
        </div>
      </ActionDialog>
    </>
  );
}
function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "SR 标签表格处理失败，请重试。";
}
