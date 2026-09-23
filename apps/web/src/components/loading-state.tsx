import { Spin } from "antd";
import { cn } from "@/lib/utils";

export function LoadingGlyph({ compact = false }: { compact?: boolean }) {
  return (
    <Spin
      aria-hidden="true"
      size={compact ? "small" : "default"}
      className={cn("loading-glyph shrink-0", compact ? "loading-glyph-compact size-4" : "size-7")}
    />
  );
}

export function LoadingState({
  label,
  description = "正在安全读取最新数据，请稍候。",
  compact = false,
}: {
  label: string;
  description?: string;
  compact?: boolean;
}) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      role="status"
      className={cn(
        "loading-state flex min-w-0 items-center gap-3 text-sm",
        compact
          ? "loading-state-compact py-2"
          : "min-h-40 justify-center rounded-xl border border-border bg-card p-6",
      )}
    >
      <LoadingGlyph compact={compact} />
      <span className="grid min-w-0 gap-1">
        <strong className="font-medium">{label}</strong>
        {!compact ? <small className="text-sm text-muted-foreground">{description}</small> : null}
      </span>
    </div>
  );
}
