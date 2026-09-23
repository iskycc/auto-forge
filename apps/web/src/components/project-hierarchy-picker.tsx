"use client";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Check, ChevronDown, FolderKanban, Plus, Settings2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { Button, Input } from "@/components/ui";
import { Menu, Popover } from "antd";

export function ProjectHierarchyPicker({
  items,
  label = "项目",
  onCreate,
  settingsLink,
  value,
  onChange,
  disabled = false,
}: {
  items: Array<{ id: string; name: string }>;
  label?: "项目" | "项目版本" | "测试阶段";
  onCreate?: () => void;
  settingsLink?: { href: string; label: string };
  value: string;
  onChange: (selectedId: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusSelectionOnOpen = useRef(false);
  const listboxId = useId();
  const selectedItem = items.find((item) => item.id === value) ?? items[0];

  const matchingItems = items.filter((item) =>
    item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  function closeAndFocusTrigger(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open || !focusSelectionOnOpen.current) return;
    const frame = requestAnimationFrame(() => {
      focusSelectionOnOpen.current = false;
      const options = containerRef.current;
      (
        options?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
        options?.querySelector<HTMLElement>('[role="option"]')
      )?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const popup = (
    <div
      ref={containerRef}
      className={cn(
        "project-picker-options",
        projectHierarchyPickerStyles["project-picker-options"],
      )}
    >
      <Input
        aria-label={`搜索${label}`}
        placeholder={`搜索${label}名称`}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <Menu
        className={cn("project-picker-matches", "max-h-[260px] overflow-y-auto border-0")}
        id={listboxId}
        role="listbox"
        aria-label={`${label}列表`}
        selectedKeys={selectedItem ? [selectedItem.id] : []}
        onClick={({ key, domEvent }) => {
          domEvent.preventDefault();
          domEvent.stopPropagation();
          closeAndFocusTrigger();
          if (key !== selectedItem?.id) onChange(key);
        }}
        items={matchingItems.map((item) => {
          const selected = item.id === selectedItem?.id;
          return {
            key: item.id,
            role: "option",
            "aria-selected": selected,
            className: "project-picker-option",
            label: (
              <span className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate" title={item.name}>
                  {item.name}
                </span>
                {selected ? <Check aria-hidden="true" size={15} /> : null}
              </span>
            ),
          };
        })}
      />
      {!matchingItems.length ? (
        <p className={cn("inline-empty", uiPatterns["inline-empty"])}>
          {items.length ? `没有匹配的${label}` : `暂无${label}`}
        </p>
      ) : null}
      <small className={cn("settings-note", uiPatterns["settings-note"])}>
        {matchingItems.length} / {items.length} 项
      </small>
      {onCreate || settingsLink ? (
        <div
          className={cn(
            "hierarchy-picker-actions",
            projectHierarchyPickerStyles["hierarchy-picker-actions"],
          )}
        >
          {onCreate ? (
            <Button
              type="button"
              className={cn(
                "hierarchy-picker-action",
                projectHierarchyPickerStyles["hierarchy-picker-action"],
              )}
              onClick={() => {
                closeAndFocusTrigger();
                onCreate();
              }}
            >
              <Plus size={15} />
              {`新建${label}`}
            </Button>
          ) : null}
          {settingsLink ? (
            <Link
              className={cn(
                "hierarchy-picker-action",
                projectHierarchyPickerStyles["hierarchy-picker-action"],
              )}
              href={settingsLink.href}
              onClick={() => setOpen(false)}
            >
              <Settings2 size={15} />
              {settingsLink.label}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
  return (
    <div
      className={cn("project-picker", projectHierarchyPickerStyles["project-picker"])}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          closeAndFocusTrigger();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (disabled) return;
          if (open && event.target instanceof Element && event.target.closest(".ant-menu")) return;
          event.preventDefault();
          if (!open) {
            setQuery("");
            focusSelectionOnOpen.current = true;
            setOpen(true);
            return;
          }
          const options = Array.from(
            containerRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
          );
          const index = options.indexOf(document.activeElement as HTMLElement);
          const forward = event.key === "ArrowDown";
          const nextIndex =
            index < 0
              ? forward
                ? 0
                : options.length - 1
              : (index + (forward ? 1 : -1) + options.length) % options.length;
          options[nextIndex]?.focus();
        }
      }}
    >
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomLeft"
        arrow={false}
        content={popup}
        destroyOnHidden
        styles={{ container: { padding: 0 } }}
      >
        <Button
          ref={triggerRef}
          disabled={disabled}
          aria-label={label === "项目" ? undefined : `当前${label}`}
          aria-controls={open ? listboxId : undefined}
          aria-expanded={open}
          aria-haspopup="listbox"
          className={
            label === "项目"
              ? cn("project-picker-trigger", projectHierarchyPickerStyles["project-picker-trigger"])
              : cn(
                  "hierarchy-picker-trigger",
                  projectHierarchyPickerStyles["hierarchy-picker-trigger"],
                )
          }
          onClick={() => {
            setQuery("");
          }}
          type="button"
        >
          {label === "项目" ? (
            <span
              className={cn(
                "project-picker-icon",
                projectHierarchyPickerStyles["project-picker-icon"],
              )}
              aria-hidden="true"
            >
              <FolderKanban size={16} />
            </span>
          ) : null}
          <span title={selectedItem?.name}>{selectedItem?.name ?? `暂无${label}`}</span>
          <ChevronDown
            className={
              open
                ? cn(
                    "project-picker-chevron open",
                    projectHierarchyPickerStyles["project-picker-chevron"],
                  )
                : cn(
                    "project-picker-chevron",
                    projectHierarchyPickerStyles["project-picker-chevron"],
                  )
            }
            size={15}
          />
        </Button>
      </Popover>
    </div>
  );
}

const projectHierarchyPickerStyles = {
  "hierarchy-picker-action":
    "flex items-center justify-start gap-2 min-w-0 border-0 rounded-lg py-2 px-3 bg-transparent shadow-none text-info text-sm [text-decoration:none] [&:hover]:bg-info/10 [&:hover]:shadow-none",
  "hierarchy-picker-actions": "grid gap-1 pt-2 border-t border-solid border-border",
  "hierarchy-picker-trigger":
    "grid w-full min-w-0 grid-cols-[minmax(0,_1fr)_auto] gap-2 py-0 px-3 border border-solid border-border rounded-lg bg-card shadow-xs text-left text-sm font-semibold [&_>_span]:min-w-0 [&_>_span]:overflow-hidden [&_>_span]:text-ellipsis [&_>_span]:whitespace-nowrap",
  "project-picker": "relative w-full",
  "project-picker-chevron":
    "text-muted-foreground transition-colors duration-150 motion-reduce:transition-none [&.open]:[transform:rotate(180deg)]",
  "project-picker-icon": "inline-grid w-7 h-7 place-items-center rounded-md bg-info/10 text-info",
  "project-picker-matches": "grid max-h-[260px] gap-1 overflow-y-auto",
  "project-picker-option":
    "flex min-h-9.5 items-center justify-between gap-3 border-0 rounded-md py-0 px-2.5 bg-transparent text-foreground text-sm text-left cursor-pointer min-w-0 [&_>_span]:min-w-0 [&_>_span]:overflow-hidden [&_>_span]:text-ellipsis [&_>_span]:whitespace-nowrap [&_>_svg]:shrink-0",
  "project-picker-options": "grid w-80 min-w-[260px] gap-2 p-2",
  "project-picker-trigger":
    "grid w-full min-h-10.5 grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-[9px] border border-solid border-border rounded-lg py-0 px-[11px] bg-card text-foreground shadow-xs text-sm font-semibold text-left cursor-pointer [&_>_span:nth-child(2)]:min-w-0 [&_>_span:nth-child(2)]:overflow-hidden [&_>_span:nth-child(2)]:text-ellipsis [&_>_span:nth-child(2)]:whitespace-nowrap",
} as const;
