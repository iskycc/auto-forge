"use client";

import { useId } from "react";
import { theme, Typography } from "antd";
import type { DocumentationDiagram } from "@/lib/user-documentation/model";

export function DocumentationDiagramView({ diagram }: { diagram: DocumentationDiagram }) {
  const { token } = theme.useToken();
  const diagramId = useId();
  return (
    <figure className="m-0 min-w-0">
      <svg
        viewBox="0 0 900 160"
        className="block w-full"
        role="img"
        aria-labelledby={`${diagramId}-title ${diagramId}-description`}
      >
        <title id={`${diagramId}-title`}>{diagram.title}</title>
        <desc id={`${diagramId}-description`}>
          {diagram.nodes.map((node) => `${node.title}：${node.detail}`).join("，然后")}。
        </desc>
        <defs>
          <marker
            id={`${diagramId}-arrow`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={token.colorPrimaryBorderHover} />
          </marker>
        </defs>
        {diagram.nodes.map((node, index) => {
          const x = 12 + index * 224;
          return (
            <g key={node.title}>
              {index < diagram.nodes.length - 1 ? (
                <path
                  d={`M ${x + 202} 79 H ${x + 218}`}
                  stroke={token.colorPrimaryBorderHover}
                  strokeWidth="2"
                  markerEnd={`url(#${diagramId}-arrow)`}
                />
              ) : null}
              <rect
                x={x}
                y="18"
                width="202"
                height="122"
                rx={token.borderRadiusLG}
                fill={index % 2 ? token.colorFillAlter : token.colorPrimaryBg}
                stroke={index % 2 ? token.colorBorderSecondary : token.colorPrimaryBorder}
              />
              <circle cx={x + 28} cy="48" r="15" fill={token.colorBgContainer} />
              <text
                x={x + 28}
                y="53"
                textAnchor="middle"
                fontSize="16"
                fontWeight="600"
                fill={token.colorPrimaryText}
              >
                {index + 1}
              </text>
              <text x={x + 18} y="88" fontSize="19" fontWeight="600" fill={token.colorText}>
                {node.title}
              </text>
              <text x={x + 18} y="114" fontSize="16" fill={token.colorTextSecondary}>
                {node.detail}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="px-1 pt-1">
        <Typography.Text type="secondary">{diagram.caption}</Typography.Text>
      </figcaption>
    </figure>
  );
}
