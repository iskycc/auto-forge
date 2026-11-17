"use client";

import { ReadOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import { documentationHref, type DocumentationTopic } from "@/lib/user-documentation/model";

export function DocumentationLink({
  topic,
  section,
  iconOnly = false,
}: {
  topic?: DocumentationTopic;
  section?: string;
  iconOnly?: boolean;
}) {
  const label = iconOnly ? "使用文档" : "使用说明";
  const link = (
    <Button
      href={documentationHref(topic, section)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      icon={<ReadOutlined />}
      type={iconOnly ? "text" : "default"}
      {...(iconOnly ? { style: { width: 36, height: 36, flexShrink: 0 } } : {})}
    >
      {iconOnly ? null : label}
    </Button>
  );
  return iconOnly ? <Tooltip title={label}>{link}</Tooltip> : link;
}
