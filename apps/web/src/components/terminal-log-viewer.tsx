"use client";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { TerminalSquare, X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui";
import { Dialog } from "@/components/ui/dialog";

/** Shared Ant Design log dialog with bounded scrolling and focus restoration. */
export function TerminalLogViewer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      backdropClassName="log-viewer-overlay"
      className={cn("log-viewer-dialog", terminalLogViewerStyles["log-viewer-dialog"])}
    >
      <div className={cn("log-viewer-titlebar", terminalLogViewerStyles["log-viewer-titlebar"])}>
        <div className={cn("log-viewer-title", terminalLogViewerStyles["log-viewer-title"])}>
          <TerminalSquare aria-hidden="true" size={17} className="shrink-0 text-primary" />
          <span className={"log-viewer-name"}>{title}</span>
        </div>
        <Button
          className={cn(
            "icon-button small-icon-button log-viewer-close",
            uiPatterns["icon-button"],
            uiPatterns["small-icon-button"],
            terminalLogViewerStyles["log-viewer-close"],
          )}
          onClick={onClose}
          type="button"
          aria-label="关闭日志终端"
        >
          <X size={16} />
        </Button>
      </div>
      <div className={cn("log-viewer-body", terminalLogViewerStyles["log-viewer-body"])}>
        {children}
      </div>
    </Dialog>
  );
}

const terminalLogViewerStyles = {
  "log-viewer-body":
    "flex min-h-0 flex-col overflow-hidden [&_.scheduling-log]:[margin:0_16px_16px] [&_.scheduling-log]:whitespace-pre [&_.scheduling-log]:[overflow-wrap:normal]",
  "log-viewer-close": "text-muted-foreground",
  "log-viewer-dialog":
    "grid w-[min(1120px,92vw)] h-[min(820px,86vh)] min-h-[430px] grid-rows-[44px_minmax(0,1fr)] overflow-hidden rounded-xl bg-card text-foreground [&_.log-toolbar]:px-4 [&_.log-toolbar]:pt-3 [&_.execution-log]:flex-1 [&_.execution-log]:min-h-0 [&_.execution-log]:max-h-none [&_.execution-log]:mx-4 [&_.execution-log]:mb-4 [&_.inline-empty]:mx-4 [&_.form-error]:mx-4 [&_.status-warning]:mx-4 [&_.compact-button]:mx-4",
  "log-viewer-title":
    "flex min-w-0 items-center gap-2 text-foreground text-sm font-medium [&_.log-viewer-name]:truncate",
  "log-viewer-titlebar":
    "flex items-center justify-between gap-3 [padding:0_10px_0_16px] border-b border-solid border-border bg-muted/50",
} as const;
