import { CircleCheck, CircleOff } from "lucide-react";
import { Badge } from "./ui/badge";

export function StatusBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <Badge className="status-badge status-ready" variant="success">
      <CircleCheck size={14} aria-hidden="true" /> 已启用
    </Badge>
  ) : (
    <Badge className="status-badge status-muted" variant="secondary">
      <CircleOff size={14} aria-hidden="true" /> 已禁用
    </Badge>
  );
}
