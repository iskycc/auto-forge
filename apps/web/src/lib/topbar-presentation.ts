import type { GlobalSearchResult, Notification } from "@autoforge/contracts";

const STATUS_LABELS: Record<string, string> = {
  queued: "等待资源",
  dispatching: "分配中",
  scheduled: "准备执行",
  running: "执行中",
  succeeded: "执行完成",
  failed: "执行失败",
  cancelled: "已终止",
};

export function notificationMessage(notification: Notification): string {
  if (notification.kind === "batch.completed") {
    const separator = notification.message.lastIndexOf("：");
    if (separator >= 0) {
      const status = notification.message.slice(separator + 1);
      const label = STATUS_LABELS[status];
      if (label) return `${notification.message.slice(0, separator)}：${label}`;
    }
  }
  if (notification.kind === "runner.offline") {
    return notification.message.replace(
      /(最近心跳：)(\d{4}-\d{2}-\d{2}T[^\s]+)/u,
      (_, prefix: string, timestamp: string) => `${prefix}${formatLocalTime(timestamp)}`,
    );
  }
  return notification.message;
}

export function searchResultSubtitle(
  item: GlobalSearchResult["items"][number],
  duplicate: boolean,
): string {
  const translated = STATUS_LABELS[item.subtitle] ?? item.subtitle;
  return duplicate ? `${translated} · 标识 ${item.id.slice(0, 8)}` : translated;
}

function formatLocalTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
