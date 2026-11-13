"use client";

import { Badge, Progress, Statistic, Tooltip, Typography, theme } from "antd";

export type DonutChartSegment = { label: string; value: number; color: string };
const RADIUS = 55;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Bounded SVG segments retain exact counts; Ant Design supplies typography, legends and progress. */
export function DonutChart({
  segments,
  centerValue,
  centerLabel,
  ariaLabel,
  size = "default",
  progressPercent,
}: {
  segments: DonutChartSegment[];
  centerValue: string;
  centerLabel: string;
  ariaLabel: string;
  size?: "default" | "large";
  progressPercent?: number;
}) {
  const { token } = theme.useToken();
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const visible = segments.filter((segment) => segment.value > 0 && total > 0);
  const diameter = size === "large" ? 192 : 104;
  const center = (
    <div className="grid justify-items-center gap-1">
      <Statistic
        value={centerValue}
        styles={{
          content: {
            fontSize: size === "large" ? 30 : 20,
            fontWeight: 650,
            lineHeight: 1.2,
            color: token.colorText,
          },
        }}
      />
      <Typography.Text type="secondary" className="!text-xs">
        {centerLabel}
      </Typography.Text>
    </div>
  );
  return (
    <figure
      className="round-donut m-0 grid min-h-56 min-w-0 grid-cols-[192px_minmax(0,176px)] items-center justify-center gap-5"
      role="img"
      aria-label={ariaLabel}
    >
      <div
        className="relative grid shrink-0 place-items-center"
        style={{ width: diameter, height: diameter }}
        aria-hidden="true"
      >
        {progressPercent === undefined ? (
          <>
            <svg className="size-full" viewBox="0 0 120 120" aria-hidden="true">
              <circle
                cx="60"
                cy="60"
                r={RADIUS}
                fill="none"
                stroke={token.colorFillSecondary}
                strokeWidth="9"
              />
              {visible.map((segment, index) => {
                const covered = visible
                  .slice(0, index)
                  .reduce((sum, previous) => sum + previous.value / total, 0);
                const length = (segment.value / total) * CIRCUMFERENCE;
                const gap = visible.length === 1 ? 0 : Math.min(2, length * 0.15);
                return (
                  <circle
                    key={segment.label}
                    cx="60"
                    cy="60"
                    r={RADIUS}
                    fill="none"
                    stroke={segment.color}
                    strokeWidth="9"
                    strokeDasharray={`${Math.max(0, length - gap)} ${CIRCUMFERENCE - Math.max(0, length - gap)}`}
                    strokeDashoffset={-covered * CIRCUMFERENCE}
                    transform="rotate(-90 60 60)"
                  />
                );
              })}
            </svg>
            <div className="absolute inset-0 grid place-items-center">{center}</div>
          </>
        ) : (
          <Progress
            type="circle"
            size={diameter}
            percent={progressPercent}
            strokeWidth={7.5}
            status="normal"
            strokeColor={segments[0]?.color ?? token.colorPrimary}
            railColor={token.colorFillSecondary}
            format={() => center}
          />
        )}
      </div>
      <figcaption className="round-donut-legend grid min-w-0 rounded-lg border border-border/60 bg-muted/40 px-3 py-1">
        {segments.map((segment) => (
          <Tooltip
            key={segment.label}
            title={`${segment.label}：${segment.value.toLocaleString()} / ${total.toLocaleString()}（${total ? Math.round((segment.value / total) * 100) : 0}%）`}
          >
            <div className="round-donut-legend-item flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-border/50 py-1 last:border-0">
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Badge color={segment.color} />
                <span>{segment.label}</span>
              </span>
              <Typography.Text strong className="!text-sm tabular-nums">
                {segment.value.toLocaleString()}
              </Typography.Text>
            </div>
          </Tooltip>
        ))}
      </figcaption>
    </figure>
  );
}
