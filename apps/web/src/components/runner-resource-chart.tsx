"use client";

import { useState } from "react";
import { Card, theme } from "antd";
import type { RunnerResourceSample } from "@autoforge/domain";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

// Fixed viewBox coordinates scale with the card. Timestamps retain real spacing;
// paths break after missing heartbeats instead of suggesting sustained activity.
const plot = { left: 30, top: 12, width: 300, height: 128 };
type Series = { label: string; color: string; value(sample: RunnerResourceSample): number };

export function RunnerResourceChart({
  title,
  samples,
  since,
  until,
  maximum,
  unit,
  series,
}: {
  title: string;
  samples: RunnerResourceSample[];
  since: string;
  until: string;
  maximum?: number;
  unit: string;
  series: Series[];
}) {
  const { token } = theme.useToken();
  const [selectedIndex, setSelectedIndex] = useState<number>();
  const selected = samples[Math.min(selectedIndex ?? samples.length - 1, samples.length - 1)];
  const start = Date.parse(since);
  const duration = Math.max(1, Date.parse(until) - start);
  const ceiling =
    maximum ??
    Math.max(1, ...samples.flatMap((sample) => series.map((item) => item.value(sample))));
  const x = (sample: RunnerResourceSample) =>
    plot.left + ((Date.parse(sample.observedAt) - start) / duration) * plot.width;
  const y = (value: number) => plot.top + plot.height * (1 - value / ceiling);
  const path = (item: Series) =>
    samples
      .map((sample, index) => {
        const previous = samples[index - 1];
        const command =
          !previous || Date.parse(sample.observedAt) - Date.parse(previous.observedAt) > 90_000
            ? "M"
            : "L";
        return `${command}${x(sample).toFixed(2)},${y(item.value(sample)).toFixed(2)}`;
      })
      .join(" ");
  return (
    <Card size="small" title={title} className="min-w-0" classNames={{ body: "!p-3" }}>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {series.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1">
            <i className="size-2 rounded-full" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <svg
        viewBox="0 0 350 165"
        className="block w-full rounded-md focus-visible:outline focus-visible:outline-primary"
        role="img"
        aria-label={`${title}，左右方向键查看样本`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          setSelectedIndex(
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? samples.length - 1
                : Math.max(
                    0,
                    Math.min(
                      samples.length - 1,
                      (selectedIndex ?? samples.length - 1) + (event.key === "ArrowLeft" ? -1 : 1),
                    ),
                  ),
          );
        }}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const time =
            start +
            ((((event.clientX - bounds.left) / bounds.width) * 350 - plot.left) / plot.width) *
              duration;
          let nearest = 0;
          for (let index = 1; index < samples.length; index++)
            if (
              Math.abs(Date.parse(samples[index]!.observedAt) - time) <
              Math.abs(Date.parse(samples[nearest]!.observedAt) - time)
            )
              nearest = index;
          setSelectedIndex(nearest);
        }}
      >
        {[0, 0.5, 1].map((ratio) => (
          <g key={ratio}>
            <line
              x1={plot.left}
              x2={plot.left + plot.width}
              y1={y(ceiling * ratio)}
              y2={y(ceiling * ratio)}
              stroke={token.colorBorderSecondary}
              strokeDasharray="3 4"
            />
            <text
              x={plot.left - 5}
              y={y(ceiling * ratio) + 4}
              textAnchor="end"
              fill={token.colorTextSecondary}
              fontSize={14}
            >
              {Number((ceiling * ratio).toFixed(1))}
            </text>
          </g>
        ))}
        {series.map((item) => (
          <g key={item.label}>
            <path
              d={path(item)}
              fill="none"
              stroke={item.color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {samples.map((sample) => (
              <circle
                key={sample.observedAt}
                cx={x(sample)}
                cy={y(item.value(sample))}
                r={1.5}
                fill={item.color}
              />
            ))}
            {selected ? (
              <circle
                cx={x(selected)}
                cy={y(item.value(selected))}
                r={3.5}
                fill={item.color}
                stroke={token.colorBgContainer}
                strokeWidth={1}
              />
            ) : null}
          </g>
        ))}
        <text x={plot.left} y={160} fill={token.colorTextSecondary} fontSize={14}>
          {formatPlatformDateTime(since, undefined, { hour: "2-digit", minute: "2-digit" })}
        </text>
        <text
          x={plot.left + plot.width}
          y={160}
          textAnchor="end"
          fill={token.colorTextSecondary}
          fontSize={14}
        >
          {formatPlatformDateTime(until, undefined, { hour: "2-digit", minute: "2-digit" })}
        </text>
      </svg>
      <div className="mt-2 grid gap-1 text-xs text-muted-foreground" aria-live="polite">
        <time dateTime={selected?.observedAt}>
          {selected ? formatPlatformDateTime(selected.observedAt) : "无样本"}
        </time>
        <span className="flex flex-wrap gap-x-3 tabular-nums">
          {selected
            ? series.map((item) => (
                <span key={item.label}>
                  {item.label}{" "}
                  <strong className="text-foreground">
                    {Number(item.value(selected).toFixed(2))}
                    {unit}
                  </strong>
                </span>
              ))
            : null}
        </span>
      </div>
    </Card>
  );
}
