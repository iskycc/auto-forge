"use client";

import { Alert, Input } from "antd";
import { useState } from "react";
import { publicSuiteEnvironmentAddressesSchema } from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { ExecutionEnvironmentAddresses } from "./execution-environment-addresses";
import { Button } from "./ui/button";

export function PublicSuiteEnvironment({
  addresses,
  enabled,
  disabled,
  overridden,
  onChange,
}: {
  addresses: string[];
  enabled: boolean;
  disabled: boolean;
  overridden: boolean;
  onChange: (addresses: string[] | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  function save() {
    const parsed = publicSuiteEnvironmentAddressesSchema.safeParse(
      draft
        .split(/\r?\n/)
        .map((address) => address.trim())
        .filter(Boolean),
    );
    if (!parsed.success) {
      setError("每行填写一个 IPv4 或 IPv6 地址，最多 128 个，不能为空或重复。");
      return;
    }
    onChange(parsed.data);
    setEditing(false);
  }

  return (
    <section className="mt-5 grid min-w-0 gap-3 border-t border-border pt-4" aria-label="执行环境">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          环境 IP{" "}
          <span className="ml-2 font-normal text-muted-foreground">
            {overridden ? "仅本次执行" : "任务默认"}
          </span>
        </span>
        {enabled ? (
          <div className="flex flex-wrap gap-2">
            {overridden ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(undefined)}
              >
                恢复任务配置
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => {
                setDraft(addresses.join("\n"));
                setError("");
                setEditing(true);
              }}
            >
              修改环境 IP
            </Button>
          </div>
        ) : null}
      </div>
      <ExecutionEnvironmentAddresses addresses={addresses} />
      <p className="m-0 text-xs leading-5 text-muted-foreground">
        {enabled
          ? "修改只用于本次立即或倒计时执行，不改变任务配置。"
          : "任务未启用 Adapter，无需下发环境 IP。"}
      </p>
      {editing ? (
        <ActionDialog
          open
          title="修改本次执行环境 IP"
          description="多个环境按任务原有规则分配给用例；其他执行配置保持不变。"
          className="w-[min(560px,calc(100dvw-3rem))]"
          onClose={() => setEditing(false)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button type="button" variant="default" disabled={disabled} onClick={save}>
                使用这些 IP
              </Button>
            </>
          }
        >
          <div className="grid gap-3">
            <label className="grid gap-2">
              <span className="text-sm font-medium">本次执行环境 IP</span>
              <Input.TextArea
                aria-label="本次执行环境 IP"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError("");
                }}
                rows={5}
                maxLength={8192}
                placeholder={"每行一个 IPv4 或 IPv6 地址\n例如：10.0.0.21"}
              />
            </label>
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              最多 128 个地址，顺序与填写顺序一致。本次提交成功后，执行表单恢复任务默认环境。
            </p>
            {error ? <Alert type="error" showIcon title={error} /> : null}
          </div>
        </ActionDialog>
      ) : null}
    </section>
  );
}
