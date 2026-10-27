"use client";

import { Tag } from "antd";

export function ExecutionEnvironmentAddresses({ addresses }: { addresses: readonly string[] }) {
  return addresses.length ? (
    <div
      className="flex max-h-40 min-w-0 flex-wrap gap-2 overflow-y-auto"
      aria-label="环境 IP 列表"
    >
      {addresses.map((address) => (
        <Tag
          key={address}
          className="!m-0 max-w-full !whitespace-normal font-mono [overflow-wrap:anywhere]"
        >
          {address}
        </Tag>
      ))}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">未配置环境 IP</span>
  );
}
