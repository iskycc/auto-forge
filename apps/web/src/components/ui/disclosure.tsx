"use client";

import { Collapse, Tooltip } from "antd";
import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useClientReadiness } from "./use-client-readiness";

type DisclosureProps = Omit<ComponentProps<"div">, "onChange"> & {
  header: ReactNode;
  headerClassName?: string;
  headerTitle?: string;
  density?: "default" | "compact";
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
  density = "default",
  showArrow = true,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  ...props
}: DisclosureProps) {
  const clientReady = useClientReadiness();
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
        collapsible={clientReady ? "header" : "disabled"}
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
        styles={{
          header: { padding: density === "compact" ? 0 : "8px 0", alignItems: "center" },
          // Ant's header-only trigger defaults to an intrinsic-width title. Keep
          // nested grids and long filenames within the available header width.
          title: { flex: "1 1 0%", minWidth: 0 },
          body: { padding: 0 },
        }}
        items={[
          {
            key: "content",
            showArrow,
            label: (
              <Tooltip title={headerTitle} trigger={["hover", "focus"]}>
                <span
                  className={cn("ui-disclosure-label", headerClassName)}
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
              </Tooltip>
            ),
            children,
            forceRender: true,
          },
        ]}
      />
    </div>
  );
}
