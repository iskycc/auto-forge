import { CircleCheck, CircleOff, Clock3 } from "lucide-react";

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

export function PlannedBadge() {
  return (
    <span className="status-badge status-planned">
      <Clock3 size={14} aria-hidden="true" /> 规划中
    </span>
  );
}
