"use client";

import { Check, ChevronDown, FolderKanban, Plus, Settings2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { Button, Input } from "@/components/ui";

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

  useEffect(() => {
    function closeWhenClickingOutside(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", closeWhenClickingOutside);
    return () => document.removeEventListener("pointerdown", closeWhenClickingOutside);
  }, []);

  useEffect(() => {
    if (!open || !focusSelectionOnOpen.current) return;
    focusSelectionOnOpen.current = false;
    const selectedOption = containerRef.current?.querySelector<HTMLButtonElement>(
      '[role="option"][aria-selected="true"]',
    );
    const firstOption = containerRef.current?.querySelector<HTMLButtonElement>('[role="option"]');
    (selectedOption ?? firstOption)?.focus();
  }, [open]);

  function closeAndFocusTrigger(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div
      className="project-picker"
      ref={containerRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          closeAndFocusTrigger();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (disabled) return;
          event.preventDefault();
          if (!open) {
            setQuery("");
            focusSelectionOnOpen.current = true;
            setOpen(true);
            return;
          }
          const options = Array.from(
            containerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
          );
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
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
      <Button
        ref={triggerRef}
        disabled={disabled}
        aria-label={label === "项目" ? undefined : `当前${label}`}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={label === "项目" ? "project-picker-trigger" : "hierarchy-picker-trigger"}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
        type="button"
      >
        {label === "项目" ? (
          <span className="project-picker-icon" aria-hidden="true">
            <FolderKanban size={16} />
          </span>
        ) : null}
        <span title={selectedItem?.name}>{selectedItem?.name ?? `暂无${label}`}</span>
        <ChevronDown
          className={open ? "project-picker-chevron open" : "project-picker-chevron"}
          size={15}
        />
      </Button>
      {open ? (
        <div className="project-picker-options">
          <Input
            aria-label={`搜索${label}`}
            placeholder={`搜索${label}名称`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div
            className="project-picker-matches"
            id={listboxId}
            role="listbox"
            aria-label={`${label}列表`}
          >
            {matchingItems.map((item) => {
              const selected = item.id === selectedItem?.id;
              return (
                <Button
                  aria-selected={selected}
                  className="project-picker-option"
                  key={item.id}
                  onClick={() => {
                    closeAndFocusTrigger();
                    if (!selected) onChange(item.id);
                  }}
                  role="option"
                  type="button"
                >
                  <span title={item.name}>{item.name}</span>
                  {selected ? <Check aria-hidden="true" size={15} /> : null}
                </Button>
              );
            })}
          </div>
          {!matchingItems.length ? (
            <p className="inline-empty">{items.length ? `没有匹配的${label}` : `暂无${label}`}</p>
          ) : null}
          <small className="settings-note">
            {matchingItems.length} / {items.length} 项
          </small>
          {onCreate || settingsLink ? (
            <div className="hierarchy-picker-actions">
              {onCreate ? (
                <Button
                  type="button"
                  className="hierarchy-picker-action"
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
                  className="hierarchy-picker-action"
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
      ) : null}
    </div>
  );
}
