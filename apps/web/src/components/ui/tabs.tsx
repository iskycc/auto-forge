"use client";

import { Tabs as AntTabs } from "antd";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useClientReadiness } from "./use-client-readiness";

export type NavigationTab<Key extends string> = {
  key: Key;
  label: ReactNode;
  disabled?: boolean;
};

/** Panels remain owned by callers so switching tabs preserves existing lazy loading and drafts. */
export function Tabs<Key extends string>({
  label,
  value,
  items,
  onChange,
  className,
}: {
  label: string;
  value: Key;
  items: NavigationTab<Key>[];
  onChange: (value: Key) => void;
  className?: string;
}) {
  const clientReady = useClientReadiness();
  return (
    <AntTabs
      ref={(tabs) => {
        // Ant Tabs applies aria-label to its outer layout, not its inner tablist.
        tabs?.nativeElement?.querySelector('[role="tablist"]')?.setAttribute("aria-label", label);
      }}
      aria-label={label}
      activeKey={value}
      items={items.map((item) => ({ ...item, disabled: item.disabled || !clientReady }))}
      onChange={(key) => {
        const selected = items.find((item) => item.key === key);
        if (selected) onChange(selected.key);
      }}
      className={cn(
        "ui-tabs min-w-0 [&>.ant-tabs-nav]:mb-0 [&>.ant-tabs-content-holder]:hidden [&_.ant-tabs-tab_a]:text-inherit",
        className,
      )}
    />
  );
}
