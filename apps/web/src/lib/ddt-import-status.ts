export function ddtImportStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    previewed: "等待确认",
    queued: "排队中",
    running: "导入中",
    cancel_requested: "取消中",
    succeeded: "已完成",
    partially_succeeded: "部分完成",
    failed: "失败",
    cancelled: "已取消",
    valid: "预检通过",
    excluded: "已排除",
    pending: "待导入",
    importing: "导入中",
  };
  return labels[value] ?? value;
}
