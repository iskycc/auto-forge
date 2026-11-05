"use client";

import { Modal } from "antd";
import type { ReactNode } from "react";

export function ExecutionCaseContentDialog({
  title,
  entries,
  onClose,
  children,
}: {
  title: string;
  entries: readonly { label: string; value: string }[];
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal open title={title} width={760} footer={null} onCancel={onClose}>
      <dl className="m-0 grid max-h-[65vh] min-w-0 gap-4 overflow-y-auto pr-2">
        {entries.map(({ label, value }) => (
          <div key={label} className="grid min-w-0 gap-2">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="m-0 rounded-lg border border-border bg-muted/40 p-3 font-mono text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {value || "—"}
            </dd>
          </div>
        ))}
      </dl>
      {children ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">{children}</div>
      ) : null}
    </Modal>
  );
}
