"use client";

import { Table, Tag } from "antd";
import type { DdtCaseHistory, DdtHistoryChange } from "@autoforge/domain";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";
import { DdtCellValuePreview } from "./ddt-cell-value-preview";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

export type DdtHistoryItem = Pick<
  DdtCaseHistory,
  | "id"
  | "changeType"
  | "sourceName"
  | "changes"
  | "createdAt"
  | "actorId"
  | "actorName"
  | "changeReason"
>;

function ChangedValue({ exists, value }: { exists: boolean; value: DdtHistoryChange["before"] }) {
  if (!exists) return <Tag>字段不存在</Tag>;
  return (
    <div className="min-w-0 [&_pre]:m-0 [&_pre]:max-h-48 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]">
      <DdtCellValuePreview value={value ?? null} />
    </div>
  );
}

export function DdtHistoryDetails({ entry, onClose }: { entry: DdtHistoryItem; onClose(): void }) {
  return (
    <ActionDialog
      open
      title="字段变更详情"
      onClose={onClose}
      description={`${formatPlatformDateTime(entry.createdAt)} · 操作人：${entry.actorName ?? entry.actorId ?? "未记录"}`}
      className="w-[min(1100px,calc(100vw-3rem))]"
      footer={
        <Button type="button" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="grid min-w-0 gap-4">
        <div className="grid min-w-0 gap-2 rounded-lg bg-muted p-3 text-sm [overflow-wrap:anywhere]">
          <span>来源：{entry.sourceName || "未记录"}</span>
          <span className="whitespace-pre-wrap">覆盖理由：{entry.changeReason || "未填写"}</span>
        </div>
        <Table<DdtHistoryChange>
          size="small"
          rowKey="field"
          dataSource={entry.changes}
          tableLayout="fixed"
          scroll={{ x: 600 }}
          pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
          columns={[
            {
              title: "字段",
              dataIndex: "field",
              width: "24%",
              render: (field: string) => <span className="[overflow-wrap:anywhere]">{field}</span>,
            },
            {
              title: "修改前",
              render: (_, change) => (
                <ChangedValue exists={change.beforeExists} value={change.before} />
              ),
            },
            {
              title: "修改后",
              render: (_, change) => (
                <ChangedValue exists={change.afterExists} value={change.after} />
              ),
            },
          ]}
        />
      </div>
    </ActionDialog>
  );
}
