"use client";
import { Table, Typography } from "antd";
import { diffDdtCaseData } from "@autoforge/domain";
import type { DdtChangeItem } from "@autoforge/application";

export function DdtChangeDiff({
  item,
  fields,
  onFieldsChange,
}: {
  item: DdtChangeItem;
  fields?: string[] | undefined;
  onFieldsChange?(fields: string[]): void;
}) {
  const changes = diffDdtCaseData(item.before, item.after);
  return (
    <Table
      size="small"
      pagination={{
        pageSize: 20,
        showSizeChanger: false,
        hideOnSinglePage: true,
        showTotal: (total) => `共 ${total} 个差异字段`,
      }}
      tableLayout="fixed"
      rowKey="field"
      dataSource={changes}
      {...(onFieldsChange
        ? {
            rowSelection: {
              selectedRowKeys: fields ?? changes.map((change) => change.field),
              onChange: (keys: React.Key[]) => onFieldsChange(keys.map(String)),
              columnWidth: 38,
            },
          }
        : {})}
      columns={[
        {
          title: "字段",
          dataIndex: "field",
          width: "22%",
          render: (field: string) => (
            <Typography.Text className="[overflow-wrap:anywhere]">{field}</Typography.Text>
          ),
        },
        {
          title: "正式库原值",
          key: "before",
          render: (_, change) => <DiffValue exists={change.beforeExists} value={change.before} />,
        },
        {
          title: "申请合入值",
          key: "after",
          render: (_, change) => <DiffValue exists={change.afterExists} value={change.after} />,
        },
      ]}
    />
  );
}

function DiffValue({ exists, value }: { exists: boolean; value: unknown }) {
  if (!exists) return <Typography.Text type="secondary">（不存在）</Typography.Text>;
  return (
    <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
