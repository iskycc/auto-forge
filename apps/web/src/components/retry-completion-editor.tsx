"use client";

import { ConfigProvider, Alert, Button, Card, InputNumber, Select, Space, Typography } from "antd";
import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import type { RetryStopRule } from "@autoforge/domain";
import { createClientIdempotencyKey } from "@/lib/client-idempotency-key";

export function RetryCompletionEditor({
  rules,
  onChange,
  disabled = false,
}: {
  rules: RetryStopRule[];
  disabled?: boolean;
  onChange: (rules: RetryStopRule[]) => void;
}) {
  function update(id: string, changes: Partial<RetryStopRule>): void {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...changes } : rule)));
  }
  return (
    <ConfigProvider componentDisabled={disabled}>
      <Card
        size="small"
        title="轮次结束条件"
        extra={
          <Button
            aria-label="添加结束条件"
            size="small"
            icon={<PlusOutlined aria-hidden />}
            onClick={() =>
              onChange([
                ...rules,
                {
                  id: createClientIdempotencyKey(),
                  afterRound: 10,
                  metric: "remainingRuns",
                  operator: "gt",
                  value: 1000,
                },
              ])
            }
          >
            添加结束条件
          </Button>
        }
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            在指定轮次全部结束后判断，任一条件满足即完成任务；未命中则继续重跑。所有用例通过时自然结束。
          </Typography.Text>
          {rules.length === 0 ? (
            <Alert
              type="info"
              showIcon
              title="未配置提前结束条件"
              description="无限重跑时将持续重跑未通过用例，直到全部通过或手动终止。"
            />
          ) : null}
          {rules.map((rule, index) => (
            <div
              key={rule.id}
              className="grid grid-cols-[minmax(100px,1fr)_minmax(150px,1.5fr)_90px_minmax(110px,1fr)_32px] items-end gap-3"
            >
              <label className="grid min-w-0 gap-2">
                <span>第几轮结束后</span>
                <InputNumber
                  aria-label={`结束条件 ${index + 1} 轮次`}
                  min={1}
                  precision={0}
                  value={rule.afterRound}
                  style={{ width: "100%" }}
                  onChange={(value) => update(rule.id, { afterRound: value ?? 0 })}
                />
              </label>
              <label className="grid min-w-0 gap-2">
                <span>判断指标</span>
                <Select
                  aria-label={`结束条件 ${index + 1} 指标`}
                  value={rule.metric}
                  onChange={(metric) =>
                    update(rule.id, { metric, value: metric === "remainingRuns" ? 1000 : 90 })
                  }
                  options={[
                    { value: "remainingRuns", label: "剩余未通过用例数" },
                    { value: "cumulativePassRate", label: "累计通过率" },
                    { value: "roundPassRate", label: "本轮通过率" },
                  ]}
                />
              </label>
              <label className="grid min-w-0 gap-2">
                <span>比较</span>
                <Select
                  aria-label={`结束条件 ${index + 1} 比较`}
                  value={rule.operator}
                  onChange={(operator) => update(rule.id, { operator })}
                  options={[
                    { value: "gt", label: "大于" },
                    { value: "gte", label: "不少于" },
                    { value: "lt", label: "小于" },
                    { value: "lte", label: "不超过" },
                  ]}
                />
              </label>
              <label className="grid min-w-0 gap-2">
                <span>{rule.metric === "remainingRuns" ? "数量" : "通过率（%）"}</span>
                <InputNumber
                  aria-label={`结束条件 ${index + 1} 阈值`}
                  min={0}
                  {...(rule.metric === "remainingRuns"
                    ? { precision: 0 }
                    : { max: 100, precision: 2 })}
                  value={rule.value}
                  style={{ width: "100%" }}
                  onChange={(value) => update(rule.id, { value: value ?? 0 })}
                />
              </label>
              <Button
                aria-label={`删除结束条件 ${index + 1}`}
                icon={<DeleteOutlined />}
                onClick={() => onChange(rules.filter((candidate) => candidate.id !== rule.id))}
              />
            </div>
          ))}
        </Space>
      </Card>
    </ConfigProvider>
  );
}
