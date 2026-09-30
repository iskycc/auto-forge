"use client";

import { Splitter } from "antd";
import { GripHorizontal, GripVertical } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

const layouts = {
  columns: {
    label: "调整调试配置与日志宽度",
    initial: 32,
    minimum: 280,
    maximum: 480,
    secondMinimum: 360,
  },
  rows: {
    label: "调整执行信息与日志高度",
    initial: 24,
    minimum: 64,
    maximum: "55%",
    secondMinimum: 220,
  },
} as const;

/** Keep split proportions when the viewport changes; hidden debug tabs stay mounted. */
export function CaseDebugSplitter({
  direction,
  first,
  second,
}: {
  direction: keyof typeof layouts;
  first: ReactNode;
  second: ReactNode;
}) {
  const layout = layouts[direction];
  const vertical = direction === "rows";
  const [percentage, setPercentage] = useState<number>(layout.initial);
  const [extent, setExtent] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const separatorSelector = ":scope > .ant-splitter > .ant-splitter-bar > [role=separator]";

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const separator = element.querySelector(separatorSelector);
    separator?.setAttribute("aria-label", layout.label);
    separator?.setAttribute("tabindex", "0");
    separator?.setAttribute("title", "拖动或使用方向键调整，双击或按 Home 恢复默认比例");
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const size = vertical ? entry.contentRect.height : entry.contentRect.width;
      if (size > 0) setExtent(size);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout.label, vertical]);

  const maximum = Math.max(
    0,
    Math.min(
      typeof layout.maximum === "number"
        ? layout.maximum
        : (extent * Number.parseFloat(layout.maximum)) / 100,
      extent - layout.secondMinimum,
    ),
  );
  const firstSize = extent
    ? Math.max(Math.min(layout.minimum, maximum), Math.min(maximum, (extent * percentage) / 100))
    : `${percentage}%`;

  return (
    <div
      ref={container}
      className="h-full min-h-0 min-w-0 flex-1"
      onKeyDown={(event) => {
        const separator = container.current?.querySelector(separatorSelector);
        if (!separator || event.target !== separator) return;
        const increase = vertical ? "ArrowDown" : "ArrowRight";
        const decrease = vertical ? "ArrowUp" : "ArrowLeft";
        if (![increase, decrease, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Home") {
          setPercentage(layout.initial);
          return;
        }
        const minimum = Number(separator.getAttribute("aria-valuemin"));
        const maximum = Number(separator.getAttribute("aria-valuemax"));
        const current = Number(separator.getAttribute("aria-valuenow"));
        const next = event.key === "End" ? maximum : current + (event.key === increase ? 3 : -3);
        setPercentage(Math.max(minimum, Math.min(maximum, next)));
      }}
    >
      <Splitter
        vertical={vertical}
        className="h-full min-h-0 min-w-0"
        styles={{ panel: { overflow: "hidden" } }}
        classNames={{ dragger: { default: "focus-visible:outline-2 focus-visible:outline-ring" } }}
        draggerIcon={vertical ? <GripHorizontal size={16} /> : <GripVertical size={16} />}
        onResize={(sizes) => {
          const total = sizes.reduce((sum, size) => sum + size, 0);
          if (total > 0 && sizes[0] !== undefined) setPercentage((sizes[0] / total) * 100);
        }}
        onDraggerDoubleClick={() => setPercentage(layout.initial)}
      >
        <Splitter.Panel
          size={firstSize}
          min={layout.minimum}
          max={layout.maximum}
          className={vertical ? "min-h-0 pb-2" : "min-h-0 pr-2"}
        >
          {first}
        </Splitter.Panel>
        <Splitter.Panel
          min={layout.secondMinimum}
          className={vertical ? "min-h-0 pt-2" : "min-h-0 pl-2"}
        >
          {second}
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}
