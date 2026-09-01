import { Sparkles } from "lucide-react";

export function LoadingGlyph({ compact = false }: { compact?: boolean }) {
  return (
    <span aria-hidden="true" className={`loading-glyph${compact ? " loading-glyph-compact" : ""}`}>
      <span className="loading-glyph-halo" />
      <span className="loading-glyph-core">
        <Sparkles size={compact ? 12 : 18} />
      </span>
      <span className="loading-glyph-orbit">
        <i />
      </span>
    </span>
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
      className={`loading-state${compact ? " loading-state-compact" : ""}`}
      role="status"
    >
      <LoadingGlyph compact={compact} />
      <span>
        <strong>{label}</strong>
        {!compact ? <small>{description}</small> : null}
      </span>
    </div>
  );
}
