"use client";
import { EmptyState } from "@/components/ui/empty-state";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useRef, useState } from "react";
import { Button, Input } from "./ui";

export type CheckboxGroupOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
};

/** Selection is local; filtering must never remove previously selected form values. */
export function CheckboxGroup({
  className,
  defaultValue = [],
  disabled = false,
  label,
  name,
  options,
  required = false,
  onSelectionChange,
}: {
  className?: string;
  defaultValue?: readonly string[];
  disabled?: boolean;
  label: string;
  name: string;
  options: readonly CheckboxGroupOption[];
  required?: boolean;
  onSelectionChange?: (values: string[]) => void;
}) {
  const initialSelection = useRef(new Set(defaultValue));
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  const [selected, setSelected] = useState(() => new Set(defaultValue));
  const [query, setQuery] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = options.filter(
    (option) =>
      (!selectedOnly || selected.has(option.value)) &&
      (!normalized ||
        `${option.label} ${option.description ?? ""} ${option.value}`
          .toLocaleLowerCase()
          .includes(normalized)),
  );
  const visibleValues = new Set(visible.map((option) => option.value));
  const groups = [...new Set(visible.map((option) => option.group ?? "可选项"))];
  const selectedCount = options.filter((option) => selected.has(option.value)).length;

  useEffect(() => {
    const form = fieldsetRef.current?.closest("form");
    const reset = () => {
      setSelected(new Set(initialSelection.current));
      setQuery("");
      setSelectedOnly(false);
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);

  function select(values: readonly string[], checked: boolean): void {
    const next = new Set(selected);
    for (const value of values) {
      if (checked) next.add(value);
      else next.delete(value);
    }
    setSelected(next);
    fieldsetRef.current?.dispatchEvent(new Event("change", { bubbles: true }));
    onSelectionChange?.([...next]);
  }

  return (
    <fieldset
      className={cn(
        checkboxGroupStyles["ui-checkbox-group"],
        `ui-checkbox-group ${options.length <= 5 && !normalized && !selectedOnly ? cn("compact-choices", checkboxGroupStyles["compact-choices"]) : ""} ${className ?? ""}`,
      )}
      disabled={disabled}
      ref={fieldsetRef}
    >
      <legend>{label}</legend>
      <div className={cn("choice-toolbar", checkboxGroupStyles["choice-toolbar"])}>
        <Input
          aria-label={`搜索${label}`}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索名称或说明"
          type="search"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          value={query}
        />
        <span aria-live="polite">
          已选 {selectedCount} / {options.length}
        </span>
        <Button
          onClick={() =>
            select(
              visible.map((option) => option.value),
              true,
            )
          }
          disabled={!visible.length}
          size="compact"
          type="button"
        >
          {normalized || selectedOnly ? "全选搜索结果" : "全选"}
        </Button>
        <Button
          onClick={() =>
            select(
              (normalized || selectedOnly ? visible : options).map((option) => option.value),
              false,
            )
          }
          disabled={!selectedCount}
          size="compact"
          type="button"
        >
          {normalized || selectedOnly ? "取消搜索结果" : "取消全选"}
        </Button>
        <Button
          aria-pressed={selectedOnly}
          onClick={() => setSelectedOnly((value) => !value)}
          size="compact"
          type="button"
        >
          仅看已选
        </Button>
      </div>
      {options
        .filter((option) => selected.has(option.value) && !visibleValues.has(option.value))
        .map((option) => (
          <input key={option.value} name={name} type="hidden" value={option.value} />
        ))}
      <div className={cn("choice-groups", checkboxGroupStyles["choice-groups"])}>
        {groups.map((group) => {
          const members = visible.filter((option) => (option.group ?? "可选项") === group);
          const count = members.filter((option) => selected.has(option.value)).length;
          return (
            <section
              className={cn("choice-section", checkboxGroupStyles["choice-section"])}
              key={group}
            >
              {options.some((option) => option.group) ? (
                <label
                  className={cn(
                    "choice-group-heading",
                    checkboxGroupStyles["choice-group-heading"],
                  )}
                >
                  <Input
                    aria-label={`选择${group}`}
                    checked={count === members.length}
                    indeterminate={count > 0 && count < members.length}
                    onChange={(event) =>
                      select(
                        members.map((option) => option.value),
                        event.target.checked,
                      )
                    }
                    type="checkbox"
                  />
                  <strong>{group}</strong>
                  <small>
                    {count} / {members.length}
                  </small>
                </label>
              ) : null}
              <div
                className={cn(
                  "ui-checkbox-group-options",
                  checkboxGroupStyles["ui-checkbox-group-options"],
                )}
              >
                {members.map((option) => (
                  <label
                    className={cn("ui-checkbox-option", checkboxGroupStyles["ui-checkbox-option"])}
                    key={option.value}
                    title={option.description}
                  >
                    <Input
                      checked={selected.has(option.value)}
                      name={name}
                      onChange={(event) => select([option.value], event.target.checked)}
                      required={
                        required && selectedCount === 0 && visible[0]?.value === option.value
                      }
                      type="checkbox"
                      value={option.value}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          );
        })}
        {!visible.length ? (
          <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
            没有匹配项。请调整搜索或关闭“仅看已选”。
          </EmptyState>
        ) : null}
      </div>
    </fieldset>
  );
}

const checkboxGroupStyles = {
  "choice-group-heading":
    "flex! items-center gap-2! py-2.5 px-3 bg-muted [&_>_input]:w-4! [&_>_input]:h-4! [&_>_small]:ml-auto [&_>_small]:text-muted-foreground",
  "choice-groups":
    "max-h-[340px] overflow-auto border border-solid border-border rounded-lg [&_.ui-checkbox-group-options]:border-0 [&_.ui-checkbox-group-options]:max-h-none [&_.ui-checkbox-group-options]:overflow-visible",
  "choice-section":
    "[&_+_.choice-section]:border-t [&_+_.choice-section]:border-solid [&_+_.choice-section]:border-border",
  "choice-toolbar":
    "flex flex-wrap items-center gap-2 mb-2 [&_>_.ui-field-feedback]:[flex:1_1_200px] [&_>_.ui-field-feedback]:min-w-0 [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_>_span]:whitespace-nowrap",
  "compact-choices":
    "[&_.choice-toolbar]:justify-end [&_.choice-toolbar_:is(input,_button:last-child)]:hidden [&_.choice-groups]:max-h-none [&_.choice-toolbar_>_span]:mr-auto",
  "ui-checkbox-group":
    "min-w-0 m-0 border-0 p-0 [&_>_legend]:mb-[7px] [&_>_legend]:text-muted-foreground [&_>_legend]:text-xs [&_>_legend]:font-semibold",
  "ui-checkbox-group-options":
    "grid grid-cols-2 max-h-[300px] overflow-auto border border-solid border-border rounded-lg p-[7px] bg-card",
  "ui-checkbox-option":
    "min-w-0 [overflow-wrap:anywhere] grid! grid-cols-[18px_minmax(0,_1fr)] items-start gap-[9px]! rounded-md p-2 cursor-pointer [&:hover]:bg-muted [&_>_.ui-input]:w-4.5! [&_>_.ui-input]:mt-px [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-0.5 [&_strong]:text-foreground [&_strong]:text-xs [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:font-medium [&_small]:leading-[1.4]",
} as const;
