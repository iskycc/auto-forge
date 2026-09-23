"use client";

import { Segmented as AntSegmented } from "antd";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
  block = false,
}: {
  label: string;
  value: Value;
  options: { value: Value; label: ReactNode; disabled?: boolean }[];
  onChange: (value: Value) => void;
  className?: string;
  block?: boolean;
}) {
  const name = useId();
  return (
    <AntSegmented<Value>
      aria-label={label}
      name={name}
      block={block}
      value={value}
      options={options}
      onChange={onChange}
      className={cn(
        "segmented-control max-w-full [&_.ant-segmented-item-label]:inline-flex [&_.ant-segmented-item-label]:items-center [&_.ant-segmented-item-label]:gap-2",
        className,
      )}
    />
  );
}
