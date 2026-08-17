"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Button } from "@/components/ui";

/** 共享的终端弹窗外壳：遮罩、macOS 风格标题栏、Esc 关闭、滚动内容区。 */
export function TerminalLogViewer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="log-viewer-overlay" role="presentation" onClick={onClose}>
      <div
        className="log-viewer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="log-viewer-titlebar">
          <div className="log-viewer-title">
            <span className="log-viewer-dot log-viewer-dot-red" />
            <span className="log-viewer-dot log-viewer-dot-yellow" />
            <span className="log-viewer-dot log-viewer-dot-green" />
            <span className="log-viewer-name">{title}</span>
          </div>
          <Button
            className="icon-button small-icon-button log-viewer-close"
            onClick={onClose}
            type="button"
            aria-label="关闭日志终端"
          >
            <X size={16} />
          </Button>
        </div>
        <div className="log-viewer-body">{children}</div>
      </div>
    </div>
  );
}
