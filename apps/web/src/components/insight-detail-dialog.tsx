"use client";
import { cn } from "@/lib/utils";

import { Maximize2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ActionDialog } from "./action-dialog";
import { Button } from "./ui";

export function InsightDetailDialog({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        aria-haspopup="dialog"
        className={cn(
          "insight-detail-trigger",
          insightDetailDialogStyles["insight-detail-trigger"],
        )}
        onClick={() => setOpen(true)}
        size="compact"
        type="button"
        variant="ghost"
      >
        <Maximize2 aria-hidden="true" size={15} />
        查看明细
      </Button>
      <ActionDialog
        backdropClassName="p-3"
        className={cn("insight-detail-dialog", insightDetailDialogStyles["insight-detail-dialog"])}
        description={description}
        onClose={() => setOpen(false)}
        open={open}
        title={title}
      >
        {children}
      </ActionDialog>
    </>
  );
}

const insightDetailDialogStyles = {
  "insight-detail-dialog":
    "w-[min(1480px,calc(100vw-1.5rem))] max-w-[calc(100vw-1.5rem)] max-h-[calc(100dvh-1.5rem)] [&_.action-dialog-body]:flex [&_.action-dialog-body]:[flex:1_1_auto] [&_.action-dialog-body]:min-h-0 [&_.action-dialog-body]:overflow-hidden",
  "insight-detail-trigger": "[flex:0_0_auto] gap-1.5 whitespace-nowrap",
} as const;
