"use client";

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
      className={`ui-checkbox-group ${options.length <= 5 && !normalized && !selectedOnly ? "compact-choices" : ""} ${className ?? ""}`}
      disabled={disabled}
      ref={fieldsetRef}
    >
      <legend>{label}</legend>
      <div className="choice-toolbar">
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
      <div className="choice-groups">
        {groups.map((group) => {
          const members = visible.filter((option) => (option.group ?? "可选项") === group);
          const count = members.filter((option) => selected.has(option.value)).length;
          return (
            <section className="choice-section" key={group}>
              {options.some((option) => option.group) ? (
                <label className="choice-group-heading">
                  <Input
                    aria-label={`选择${group}`}
                    checked={count === members.length}
                    ref={(element) => {
                      if (element) element.indeterminate = count > 0 && count < members.length;
                    }}
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
              <div className="ui-checkbox-group-options">
                {members.map((option) => (
                  <label
                    className="ui-checkbox-option"
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
          <p className="inline-empty">没有匹配项。请调整搜索或关闭“仅看已选”。</p>
        ) : null}
      </div>
    </fieldset>
  );
}
