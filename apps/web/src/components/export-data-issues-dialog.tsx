"use client";

import { Table, type TableColumnsType } from "antd";
import type { ExportRowIssue, ExportValidationReport } from "@autoforge/contracts";
import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui";
import { Notice } from "@/components/ui/notice";

const columns: TableColumnsType<ExportRowIssue> = [
  {
    title: "原导出行",
    dataIndex: "rowNumber",
    width: 96,
    render: (value: number, issue) => (
      <span>
        第 {value} 行<br />
        <span className="text-xs text-muted-foreground">第 {issue.round} 轮</span>
      </span>
    ),
  },
  {
    title: "用例",
    width: 250,
    render: (_value: unknown, issue) => (
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <strong className="font-medium">{issue.caseName || "未记录名称"}</strong>
        <div className="mt-1 text-xs text-muted-foreground">
          {issue.casePath || issue.executionRunId}
        </div>
      </div>
    ),
  },
  {
    title: "字段与问题",
    render: (_value: unknown, issue) => (
      <div className="grid gap-1 [overflow-wrap:anywhere]">
        {issue.fields.map(({ field, reason }, index) => (
          <div key={index}>
            <strong className="font-medium">{field}：</strong>
            {reason}
          </div>
        ))}
      </div>
    ),
  },
];

export function ExportDataIssuesDialog({
  report,
  exporting,
  error,
  onExclude,
  onClose,
}: {
  report: ExportValidationReport;
  exporting: boolean;
  error: string;
  onExclude: () => void;
  onClose: () => void;
}) {
  return (
    <ActionDialog
      open
      title="导出数据存在问题"
      className="w-[min(860px,calc(100vw_-_64px))]"
      closeDisabled={exporting}
      onClose={onClose}
      description="以下记录包含 Excel 无法保存的字段，当前尚未下载文件。"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button disabled={exporting} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={exporting} disabled={exporting} onClick={onExclude}>
            {report.validRows === 0 ? "导出异常明细" : "排除异常数据并导出"}
          </Button>
        </div>
      }
    >
      <div className="grid min-w-0 gap-4">
        <Notice tone="warning">
          共 {report.totalRows} 条记录，{report.excludedRows} 条存在问题，{report.validRows}{" "}
          条可正常导出。
          {report.validRows === 0
            ? "排除后没有正常记录，文件将保留表头及异常明细。"
            : "继续导出将排除整条异常记录，正常记录保持完整。"}
          原始数据不会被修改。
        </Notice>
        {error ? (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        ) : null}
        <Table<ExportRowIssue>
          size="small"
          rowKey="rowNumber"
          columns={columns}
          dataSource={report.issues}
          tableLayout="fixed"
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ y: 280 }}
        />
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          {report.truncated ? `弹窗展示前 ${report.issues.length} 条异常记录。` : ""}
          导出文件中的“排除明细”工作表会列出全部异常记录及原因。
        </p>
      </div>
    </ActionDialog>
  );
}
