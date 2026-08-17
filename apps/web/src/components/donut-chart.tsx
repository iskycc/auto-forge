export type DonutChartSegment = {
  label: string;
  value: number;
  // 语义 token 引用，如 "var(--color-success)"；组件不硬编码任何颜色。
  color: string;
};

const RADIUS = 45;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * 自绘 SVG 环形图：分段圆环 + 中心文字 + 图例。
 * figure 以 role="img" + aria-label 提供与图形等价的文本描述，SVG 本体对读屏隐藏。
 */
export function DonutChart({
  segments,
  centerValue,
  centerLabel,
  ariaLabel,
}: {
  segments: DonutChartSegment[];
  centerValue: string;
  centerLabel: string;
  ariaLabel: string;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const visible = segments.filter((segment) => segment.value > 0 && total > 0);
  // 分段很少（结果分布 4 段、进度 2 段），用纯函数按序累计偏移，避免渲染期可变状态。
  const arcs = visible.map((segment, index) => {
    const fraction = segment.value / total;
    const covered = visible
      .slice(0, index)
      .reduce((sum, previous) => sum + previous.value / total, 0);
    return {
      segment,
      // 多分段时留出 2 像素的视觉间隔，单分段（满环）不留缺口。
      dash: Math.max(0, fraction * CIRCUMFERENCE - (fraction < 1 ? 2 : 0)),
      offset: -covered * CIRCUMFERENCE,
    };
  });

  return (
    <figure className="round-donut" role="img" aria-label={ariaLabel}>
      <svg className="round-donut-svg" viewBox="0 0 120 120" aria-hidden="true">
        <circle
          className="round-donut-track"
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          strokeWidth="14"
        />
        {arcs.map(({ segment, dash, offset }) => (
          <circle
            key={segment.label}
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            stroke={segment.color}
            strokeWidth="14"
            strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
            strokeDashoffset={offset}
            transform="rotate(-90 60 60)"
          />
        ))}
        <text className="round-donut-value" x="60" y="58" textAnchor="middle">
          {centerValue}
        </text>
        <text className="round-donut-caption" x="60" y="76" textAnchor="middle">
          {centerLabel}
        </text>
      </svg>
      <figcaption className="round-donut-legend">
        {segments.map((segment) => (
          <span className="round-donut-legend-item" key={segment.label}>
            <span
              className="round-donut-swatch"
              style={{ backgroundColor: segment.color }}
              aria-hidden="true"
            />
            {segment.label} {segment.value}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
