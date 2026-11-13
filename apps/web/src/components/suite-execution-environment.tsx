"use client";

import { useState } from "react";
import { Settings2 } from "lucide-react";
import type { CaseSuite } from "@autoforge/domain";
import { useSuiteExecutionEnvironment } from "@/lib/suite-execution-environment";
import { EnvironmentAddressesDialog } from "./environment-addresses-dialog";
import { ExecutionEnvironmentAddresses } from "./execution-environment-addresses";
import { Button } from "./ui/button";

export function SuiteExecutionEnvironment({
  suite,
  userId,
  canExecute,
  compact = false,
  timing = "next",
}: {
  suite: Pick<CaseSuite, "id" | "status" | "enabled" | "policy">;
  userId: string;
  canExecute: boolean;
  compact?: boolean;
  timing?: "current" | "next";
}) {
  const draft = useSuiteExecutionEnvironment(userId, suite.id);
  const [editing, setEditing] = useState(false);
  const enabled = suite.policy.adapter.enabled;
  const overridden = enabled && Boolean(draft.addresses);
  const addresses = draft.addresses ?? suite.policy.adapter.environmentAddresses;
  const disabled = !canExecute || !enabled || !suite.enabled || suite.status !== "active";
  const executionLabel = timing === "current" ? "本次" : "下次";
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      {draft.addresses ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!canExecute || suite.status !== "active"}
          onClick={() => draft.setAddresses(undefined)}
        >
          恢复任务默认
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={() => setEditing(true)}
      >
        <Settings2 size={15} />
        {compact ? "环境 IP" : timing === "current" ? "修改本次执行环境 IP" : "修改下次执行 IP"}
      </Button>
      {compact && overridden ? (
        <span className="text-xs text-info">{executionLabel}使用自定义 IP</span>
      ) : null}
    </div>
  );
  return (
    <>
      {compact ? (
        controls
      ) : (
        <section
          className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-4"
          aria-label={`${executionLabel}执行环境`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">
                {timing === "current" ? "本次" : "下一次"}执行环境 IP
              </span>
              <span className="text-xs text-muted-foreground">
                {overridden ? `仅${executionLabel}执行` : "任务默认"}
              </span>
            </div>
            {controls}
          </div>
          {enabled ? (
            <ExecutionEnvironmentAddresses addresses={addresses} />
          ) : (
            <span className="text-sm text-muted-foreground">未启用 Adapter</span>
          )}
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            修改只对{timing === "current" ? "本次" : "下一次"}
            手动立即或倒计时执行生效，提交成功后恢复任务默认；取消或提交失败时保留。任务锁定不影响此操作，不改变任务配置。
          </p>
        </section>
      )}
      {editing ? (
        <EnvironmentAddressesDialog
          addresses={addresses}
          title={`修改${executionLabel}执行环境 IP`}
          label={`${executionLabel}执行环境 IP`}
          description={`只用于本浏览器页面内该任务的${timing === "current" ? "本次" : "下一次"}手动执行，其他用户和正在执行的批次不受影响；刷新页面恢复任务默认。`}
          disabled={disabled}
          onClose={() => setEditing(false)}
          onSave={(values) => {
            draft.setAddresses(values);
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}
