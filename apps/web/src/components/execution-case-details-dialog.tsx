"use client";

import { Modal } from "antd";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Select } from "./ui";

export function ExecutionCaseDetailsDialog({
  scope,
  scopes,
  onScopeChange,
  onClose,
  children,
}: {
  scope: string;
  scopes: readonly { value: string; label: string }[];
  onScopeChange: (scope: string) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open
      title={<span className="sr-only">用例执行明细</span>}
      closable={false}
      keyboard={false}
      focusable={{ focusTriggerAfterClose: false }}
      mask={{ closable: false }}
      footer={null}
      width="100vw"
      className="execution-case-details-dialog"
      style={{ top: 0, margin: 0, paddingBottom: 0, maxWidth: "100vw" }}
      styles={{
        wrapper: { overflow: "hidden" },
        container: {
          height: "100dvh",
          padding: 0,
          borderRadius: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        },
        header: { margin: 0, padding: 0, height: 0 },
        body: {
          flex: "1 1 auto",
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        },
      }}
    >
      <header className="flex min-w-0 shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-4">
        <h2 className="m-0 text-lg font-semibold">用例执行明细</h2>
        <Button type="button" variant="secondary" onClick={onClose}>
          <X size={16} />
          关闭明细
        </Button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-background p-6">
        <div className="grid min-w-0 gap-4">
          <div className="flex min-w-0 items-center gap-3 text-sm">
            <span className="shrink-0 text-muted-foreground">查看范围</span>
            <div className="w-64 min-w-0">
              <Select
                aria-label="明细查看范围"
                value={scope}
                onChange={(event) => onScopeChange(event.target.value)}
              >
                {scopes.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {children}
        </div>
      </div>
    </Modal>
  );
}
