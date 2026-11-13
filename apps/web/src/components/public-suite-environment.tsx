"use client";

import { Alert } from "antd";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import type { PublicSuiteEnvironmentState } from "@autoforge/contracts";
import { useState } from "react";
import { EnvironmentAddressesDialog } from "./environment-addresses-dialog";
import { ExecutionEnvironmentAddresses } from "./execution-environment-addresses";
import { Button } from "./ui/button";

export function PublicSuiteEnvironment({
  addresses,
  enabled,
  disabled,
  environment,
  onChange,
}: {
  addresses: string[];
  enabled: boolean;
  disabled: boolean;
  environment: PublicSuiteEnvironmentState;
  onChange: (addresses: string[] | null, revision: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editingRevision, setEditingRevision] = useState(environment.revision);
  const [error, setError] = useState("");
  const overridden = !!environment.change?.addresses;
  async function reset() {
    setError("");
    try {
      await onChange(null, environment.revision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复失败，请重试。");
    }
  }

  return (
    <section className="mt-5 grid min-w-0 gap-3 border-t border-border pt-4" aria-label="执行环境">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          本次执行环境 IP{" "}
          <span className="ml-2 font-normal text-muted-foreground">
            {overridden ? "链接共享配置" : "任务默认"}
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
                onClick={() => void reset()}
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
                setError("");
                setEditingRevision(environment.revision);
                setEditing(true);
              }}
            >
              修改环境 IP
            </Button>
          </div>
        ) : null}
      </div>
      <ExecutionEnvironmentAddresses addresses={addresses} />
      {environment.change ? (
        <p
          className="m-0 break-words text-xs leading-5 text-muted-foreground"
          aria-label="环境 IP 修改记录"
        >
          {environment.change.modifiedBy.username} 已
          {overridden ? "修改环境 IP" : "恢复任务默认 IP"} ·{" "}
          {formatPlatformDateTime(environment.change.modifiedAt)}
        </p>
      ) : null}
      {error ? <Alert type="error" showIcon title={error} /> : null}
      <p className="m-0 text-xs leading-5 text-muted-foreground">
        {enabled
          ? "本次执行将使用以上 IP。同一公开链接共享最新配置，修改不影响任务默认 IP 或已创建的执行。"
          : "任务未启用 Adapter，无需下发环境 IP。"}
      </p>
      {editing ? (
        <EnvironmentAddressesDialog
          addresses={addresses}
          disabled={disabled}
          title="修改执行环境 IP"
          label="本次执行环境 IP"
          description="保存后所有访问此公开链接的人均使用最新 IP，并记录修改人；任务默认配置保持不变。"
          onClose={() => setEditing(false)}
          onSave={async (values) => {
            await onChange(values, editingRevision);
            setEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}
