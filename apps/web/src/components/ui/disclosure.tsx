"use client";

import { Collapse } from "antd";
import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type DisclosureProps = Omit<ComponentProps<"div">, "onChange"> & {
  header: ReactNode;
  headerClassName?: string;
  headerTitle?: string;
  showArrow?: boolean;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: (open: boolean) => void;
};

/** Collapse keeps form fields mounted; callers decide when expensive children are loaded. */
export function Disclosure({
  children,
  header,
  headerClassName,
  headerTitle,
  showArrow = true,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: DisclosureProps) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [previousDefault, setPreviousDefault] = useState(defaultOpen);
  if (previousDefault !== defaultOpen) {
    setPreviousDefault(defaultOpen);
    setExpanded(defaultOpen);
  }
  const active = open ?? expanded;
  return (
    <div {...props} data-open={active} className={cn("ui-disclosure min-w-0", className)}>
      <Collapse
        ghost
        size="small"
        activeKey={active ? ["content"] : []}
        onChange={(keys) => {
          const next = keys.includes("content");
          setExpanded(next);
          onOpenChange?.(next);
        }}
        classNames={{
          header: "ui-disclosure-header",
          title: "min-w-0",
          body: "ui-disclosure-body",
        }}
        styles={{ header: { padding: "8px 0", alignItems: "center" }, body: { padding: 0 } }}
        items={[
          {
            key: "content",
            showArrow,
            label: (
              <span
                className={cn("ui-disclosure-label", headerClassName)}
                title={headerTitle}
                onClick={(event) => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest("a, button, input, label")
                  )
                    event.stopPropagation();
                }}
              >
                {header}
              </span>
            ),
            children,
            forceRender: true,
          },
        ]}
      />
    </div>
  );
}
