"use client";

import { useState } from "react";
import { EnvironmentAddressesDialog } from "./environment-addresses-dialog";
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

  return (
    <section className="mt-5 grid min-w-0 gap-3 border-t border-border pt-4" aria-label="执行环境">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          下一次执行环境 IP{" "}
          <span className="ml-2 font-normal text-muted-foreground">
            {overridden ? "本页自定义" : "任务默认"}
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
          ? "本页后续立即或倒计时执行均使用这些 IP；刷新页面后恢复任务默认，不改变任务配置。"
          : "任务未启用 Adapter，无需下发环境 IP。"}
      </p>
      {editing ? (
        <EnvironmentAddressesDialog
          addresses={addresses}
          disabled={disabled}
          title="修改执行环境 IP"
          label="本次执行环境 IP"
          description="多个环境按任务原有规则分配给用例；保存后本页后续执行持续使用，刷新页面后恢复任务默认。"
          onClose={() => setEditing(false)}
          onSave={(values) => {
            onChange(values);
            setEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}
