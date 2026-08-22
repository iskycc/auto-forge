"use client";

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
        className="insight-detail-trigger"
        onClick={() => setOpen(true)}
        size="compact"
        type="button"
        variant="ghost"
      >
        <Maximize2 aria-hidden="true" size={15} />
        查看明细
      </Button>
      <ActionDialog
        className="insight-detail-dialog"
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
