import { CircleCheck, CircleOff } from "lucide-react";

export function StatusBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="status-badge status-ready">
      <CircleCheck size={14} aria-hidden="true" /> 已启用
    </span>
  ) : (
    <span className="status-badge status-muted">
      <CircleOff size={14} aria-hidden="true" /> 已禁用
    </span>
  );
}
