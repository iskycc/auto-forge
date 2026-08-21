"use client";

import { CalendarClock, Check, ChevronDown, FileUp } from "lucide-react";
import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

type ButtonVariant = "neutral" | "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "compact" | "regular" | "large";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "neutral", size = "regular", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={classes("ui-button", `ui-button-${variant}`, `ui-button-${size}`, className)}
      {...props}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={classes("ui-input", className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={classes("ui-textarea", className)} {...props} />;
});

type SelectOption = { value: string; label: string; selected: boolean };

function readSelectOptions(children: SelectHTMLAttributes<HTMLSelectElement>["children"]) {
  const options: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || child.type !== "option") return;
    const props = child.props as { value?: string; children?: unknown; selected?: boolean };
    options.push({
      value: props.value !== undefined ? String(props.value) : String(props.children ?? ""),
      label: readOptionLabel(props.children),
      selected: props.selected === true,
    });
  });
  return options;
}

function readOptionLabel(children: unknown): string {
  if (Array.isArray(children)) return children.map(readOptionLabel).join("");
  return typeof children === "string" || typeof children === "number" ? String(children) : "";
}

function createNativeSelectEvent(): Event {
  // React reads `target.value` from its synthetic wrapper, so a bubbling
  // native change event is enough for both React handlers and plain DOM
  // form submission listeners.
  return new Event("change", { bubbles: true });
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, disabled, value, defaultValue, multiple, ...props }, ref) {
    const [displayValue, setDisplayValue] = useState<string | undefined>(() =>
      value !== undefined ? String(value) : undefined,
    );
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const rootRef = useRef<HTMLSpanElement | null>(null);
    const listRef = useRef<HTMLUListElement | null>(null);
    const options = readSelectOptions(children);
    const fallbackValue =
      defaultValue !== undefined
        ? String(Array.isArray(defaultValue) ? (defaultValue[0] ?? "") : defaultValue)
        : (options.find((option) => option.selected)?.value ?? options[0]?.value ?? "");
    const currentValue = displayValue ?? fallbackValue;
    const hasOptions = options.length > 0;
    const selectedLabel = hasOptions
      ? (options.find((option) => option.value === currentValue)?.label ?? "请选择")
      : "暂无可选项";

    function syncDisplay(nextValue: string): void {
      if (value === undefined) setDisplayValue(nextValue);
    }

    // Controlled value changed: re-derive display state during render.
    if (value !== undefined && displayValue !== String(value)) {
      setDisplayValue(String(value));
    }

    useEffect(() => {
      if (!open) return;
      const onDocumentMouseDown = (event: MouseEvent) => {
        if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
      };
      document.addEventListener("mousedown", onDocumentMouseDown);
      return () => document.removeEventListener("mousedown", onDocumentMouseDown);
    }, [open]);

    useEffect(() => {
      if (!open) return;
      const activeOption = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
      activeOption?.scrollIntoView({ block: "nearest" });
    }, [open, activeIndex]);

    function openList(): void {
      if (disabled || !hasOptions) return;
      const index = options.findIndex((option) => option.value === currentValue);
      setActiveIndex(index >= 0 ? index : 0);
      setOpen(true);
    }

    function chooseOption(option: SelectOption): void {
      const control = rootRef.current?.querySelector("select");
      if (control) {
        control.value = option.value;
        control.dispatchEvent(createNativeSelectEvent());
      }
      syncDisplay(option.value);
      setOpen(false);
    }

    function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openList();
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, options.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const option = options[activeIndex];
        if (option) chooseOption(option);
      }
    }

    return (
      <span
        ref={rootRef}
        className={classes("ui-select", multiple ? "ui-select-multiple" : undefined)}
        data-disabled={disabled ? "true" : undefined}
        data-multiple={multiple ? "true" : undefined}
        data-empty={hasOptions ? undefined : "true"}
      >
        <select
          ref={ref}
          aria-hidden={!multiple}
          className={classes(
            "ui-select-control",
            multiple ? undefined : "ui-select-control-hidden",
            className,
          )}
          disabled={disabled}
          multiple={multiple}
          onChange={(event) => {
            syncDisplay(event.target.value);
            props.onChange?.(event);
          }}
          tabIndex={multiple ? 0 : -1}
          value={value !== undefined ? String(value) : undefined}
          defaultValue={value === undefined ? defaultValue : undefined}
          {...props}
        >
          {children}
        </select>
        {multiple ? null : (
          <>
            <button
              aria-label={props["aria-label"]}
              aria-expanded={open}
              aria-haspopup="listbox"
              className="ui-select-trigger"
              disabled={disabled}
              onClick={() => (open ? setOpen(false) : openList())}
              onKeyDown={handleTriggerKeyDown}
              type="button"
            >
              <span className={classes(!hasOptions && "ui-select-placeholder")}>
                {selectedLabel}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={classes("ui-select-icon", open && "ui-select-icon-open")}
                size={15}
                strokeWidth={2.2}
              />
            </button>
            {open && hasOptions ? (
              <ul className="ui-select-list" ref={listRef} role="listbox">
                {options.map((option, index) => (
                  <li
                    aria-selected={option.value === currentValue}
                    className={classes(
                      "ui-select-option",
                      index === activeIndex && "ui-select-option-active",
                    )}
                    data-active={index === activeIndex ? "true" : undefined}
                    key={option.value || `option-${index}`}
                    onClick={() => chooseOption(option)}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                  >
                    <span className="ui-select-option-label">{option.label}</span>
                    {option.value === currentValue ? (
                      <Check aria-hidden="true" size={14} strokeWidth={2.4} />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </span>
    );
  },
);

type DatetimeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  value?: string;
};

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

function safeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseDatetimeParts(value: string | undefined) {
  if (!value) {
    return { year: undefined, month: undefined, day: undefined, hour: 0, minute: 0 };
  }
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart?.split("-").map(Number) ?? [];
  const [hour, minute] = timePart?.split(":").map(Number) ?? [];
  return {
    year: typeof year === "number" && Number.isFinite(year) && year > 0 ? year : undefined,
    month: typeof month === "number" && Number.isFinite(month) && month > 0 ? month : undefined,
    day: typeof day === "number" && Number.isFinite(day) && day > 0 ? day : undefined,
    hour: safeNumber(hour, 0),
    minute: safeNumber(minute, 0),
  };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export const DatetimeInput = forwardRef<HTMLInputElement, DatetimeInputProps>(
  function DatetimeInput({ className, value, defaultValue, onChange, ...props }, ref) {
    const [currentValue, setCurrentValue] = useState<string | undefined>(
      value !== undefined ? value : typeof defaultValue === "string" ? defaultValue : undefined,
    );
    const [open, setOpen] = useState(false);
    const [alignRight, setAlignRight] = useState(false);
    const [timeText, setTimeText] = useState<string>(() => {
      const parts = parseDatetimeParts(
        value ?? (typeof defaultValue === "string" ? defaultValue : undefined),
      );
      return `${twoDigits(parts.hour ?? 0)}:${twoDigits(parts.minute ?? 0)}`;
    });
    const rootRef = useRef<HTMLSpanElement | null>(null);
    const internalRef = useRef<HTMLInputElement | null>(null);

    // Controlled value changed: re-derive display state during render.
    if (value !== undefined && currentValue !== value) {
      setCurrentValue(value);
    }

    useEffect(() => {
      if (!open) return;
      const onDocumentMouseDown = (event: MouseEvent) => {
        if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
      };
      document.addEventListener("mousedown", onDocumentMouseDown);
      return () => document.removeEventListener("mousedown", onDocumentMouseDown);
    }, [open]);

    function sync(nextValue: string): void {
      if (value === undefined) setCurrentValue(nextValue);
      const parts = parseDatetimeParts(nextValue);
      if (nextValue.includes("T"))
        setTimeText(`${twoDigits(parts.hour)}:${twoDigits(parts.minute)}`);
    }

    const parts = parseDatetimeParts(currentValue);
    const now = new Date();
    const viewYear = parts.year ?? now.getFullYear();
    const viewMonth = parts.month ?? now.getMonth() + 1;
    const calendarDays = buildCalendarDays(viewYear, viewMonth);

    function commit(datetimeValue: string): void {
      const control = internalRef.current;
      if (!control) return;
      // Bypass React's instance value tracker so its onChange observes the
      // new value; the handler below handles display sync and parent props.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(control, datetimeValue);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function chooseDay(day: number): void {
      commit(`${viewYear}-${twoDigits(viewMonth)}-${twoDigits(day)}T${timeText}`);
    }

    function handleTimeChange(event: ChangeEvent<HTMLInputElement>): void {
      const nextTime = event.target.value;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(nextTime)) {
        setTimeText(nextTime);
        return;
      }
      setTimeText(nextTime);
      const base =
        currentValue?.split("T")[0] ??
        `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
      commit(`${base}T${nextTime}`);
    }

    return (
      <span
        ref={rootRef}
        className={classes("ui-datetime", className)}
        data-disabled={props.disabled ? "true" : undefined}
        data-empty={!currentValue ? "true" : undefined}
      >
        <input
          ref={(node) => {
            internalRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          className="ui-datetime-control"
          defaultValue={defaultValue}
          onChange={(event) => {
            sync(event.target.value);
            onChange?.(event);
          }}
          type="datetime-local"
          value={value}
          {...props}
        />
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          className="ui-datetime-display"
          disabled={props.disabled}
          onClick={() => {
            const next = !open;
            if (next && rootRef.current) {
              const bounds = rootRef.current.getBoundingClientRect();
              setAlignRight(bounds.left + 260 > window.innerWidth);
            }
            setOpen(next);
          }}
          type="button"
        >
          <CalendarClock aria-hidden="true" className="ui-datetime-icon" size={15} />
          <span className={classes(!currentValue && "ui-datetime-placeholder")}>
            {currentValue ? formatDatetimeDisplay(currentValue) : "选择日期与时间"}
          </span>
        </button>
        {open ? (
          <div className={classes("ui-datetime-panel", alignRight && "ui-datetime-panel-right")}>
            <div className="ui-datetime-weekdays">
              {WEEKDAY_LABELS.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
            <div className="ui-datetime-days">
              {calendarDays.map((day, index) =>
                day === 0 ? (
                  <span className="ui-datetime-day-blank" key={`blank-${index}`} />
                ) : (
                  <button
                    className={classes(
                      "ui-datetime-day",
                      day === parts.day && "ui-datetime-day-selected",
                    )}
                    key={`${viewMonth}-${day}`}
                    onClick={() => chooseDay(day)}
                    type="button"
                  >
                    {day}
                  </button>
                ),
              )}
            </div>
            <label className="ui-datetime-time">
              时间
              <input
                aria-label="时间 HH:MM"
                maxLength={5}
                onChange={handleTimeChange}
                placeholder="HH:MM"
                value={timeText}
              />
            </label>
          </div>
        ) : null}
      </span>
    );
  },
);

function buildCalendarDays(year: number, month: number): number[] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const leadingBlanks = (firstWeekday + 6) % 7;
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [
    ...Array.from({ length: leadingBlanks }, () => 0),
    ...Array.from({ length: dayCount }, (_, index) => index + 1),
  ];
}

function formatDatetimeDisplay(value: string): string {
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return value;
  const [year, month, day] = datePart.split("-");
  if (!year || !month || !day) return value;
  return `${year}/${month}/${day} ${timePart.slice(0, 5)}`;
}

type FileInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export const FileInput = forwardRef<HTMLInputElement, FileInputProps>(function FileInput(
  { className, onChange, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [fileName, setFileName] = useState<string | undefined>(undefined);

  return (
    <span
      className={classes("ui-file", className)}
      data-disabled={props.disabled ? "true" : undefined}
      data-empty={!fileName ? "true" : undefined}
    >
      <input
        id={inputId}
        ref={ref}
        className="ui-file-control"
        onChange={(event) => {
          setFileName(event.target.files?.item(0)?.name);
          onChange?.(event);
        }}
        type="file"
        {...props}
      />
      <label className="ui-file-trigger" htmlFor={inputId}>
        <FileUp aria-hidden="true" size={15} />
        选择文件
      </label>
      <span className="ui-file-name">{fileName ?? "未选择任何文件"}</span>
    </span>
  );
});

export function ProgressBar({
  value,
  max = 100,
  label,
}: {
  value: number;
  max?: number;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(max, value));
  const percent = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <span
      aria-valuemax={max}
      aria-valuemin={0}
      aria-valuenow={clamped}
      className="ui-progress"
      role="progressbar"
      aria-label={label}
    >
      <span className="ui-progress-fill" style={{ width: `${percent}%` }} />
    </span>
  );
}

function classes(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}
