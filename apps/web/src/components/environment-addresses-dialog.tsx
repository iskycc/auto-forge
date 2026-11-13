"use client";

import { Alert, Input } from "antd";
import { Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import {
  caseSuiteAdapterConfigurationSchema,
  executionEnvironmentIpsSchema,
} from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { ExecutionEnvironmentAddresses } from "./execution-environment-addresses";
import { Button } from "./ui/button";

type EnvironmentAddressOptions = {
  addresses: readonly string[];
  disabled?: boolean;
  validation?: "ip" | "address";
  allowEmpty?: boolean;
  description: string;
  label?: string;
};

export function EnvironmentAddressesDialog({
  addresses,
  disabled = false,
  validation = "ip",
  allowEmpty = false,
  description,
  label = "环境 IP",
  title = "修改环境 IP",
  confirmLabel = "使用这些 IP",
  onClose,
  onSave,
}: EnvironmentAddressOptions & {
  title?: string;
  confirmLabel?: string;
  onClose: () => void;
  onSave: (addresses: string[]) => void | Promise<void>;
}) {
  const nextRowId = useRef(addresses.length || 1);
  const [rows, setRows] = useState(() =>
    (addresses.length ? addresses : [""]).map((value, id) => ({ id, value })),
  );
  const [error, setError] = useState("");

  const [saving, setSaving] = useState(false);
  const busy = disabled || saving;

  async function save() {
    if (busy) return;
    const values = rows.map((row) => row.value.trim());
    const schema =
      validation === "ip"
        ? executionEnvironmentIpsSchema
        : caseSuiteAdapterConfigurationSchema.shape.environmentAddresses;
    const parsed = schema.safeParse(allowEmpty && values.every((value) => !value) ? [] : values);
    if (!parsed.success) {
      setError(
        validation === "ip"
          ? "每个输入框填写一个 IPv4 或 IPv6 地址，最多 128 个，不能为空或重复。"
          : "每个输入框填写一个环境 IP 或地址，最多 128 个，不能为空或重复。无需填写时请清空全部输入框。",
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(parsed.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionDialog
      open
      title={title}
      description={description}
      className="w-[min(560px,calc(100dvw-3rem))]"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={() => void save()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div
        className="grid min-w-0 gap-4"
        aria-label={`${label}编辑列表`}
        // Portal drafts must not mark the surrounding task form as changed before saving.
        onChange={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">{rows.length} / 128</span>
        </div>
        <div className="grid min-w-0 gap-3">
          {rows.map((row, index) => (
            <div
              key={row.id}
              className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2"
            >
              <span className="text-center text-xs text-muted-foreground">{index + 1}</span>
              <Input
                aria-label={`${label} ${index + 1}`}
                value={row.value}
                disabled={busy}
                maxLength={validation === "ip" ? 45 : 2048}
                placeholder="例如：10.0.0.21 或 2001:db8::1"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void save();
                  }
                }}
                onChange={(event) => {
                  setRows((current) =>
                    current.map((candidate) =>
                      candidate.id === row.id
                        ? { ...candidate, value: event.target.value }
                        : candidate,
                    ),
                  );
                  setError("");
                }}
              />
              <Button
                type="button"
                variant="ghost"
                aria-label={`删除${label} ${index + 1}`}
                disabled={busy || rows.length === 1}
                onClick={() => {
                  setRows((current) => current.filter((candidate) => candidate.id !== row.id));
                  setError("");
                }}
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || rows.length >= 128}
          onClick={() => {
            setRows((current) => [...current, { id: nextRowId.current++, value: "" }]);
            setError("");
          }}
        >
          <Plus size={16} />
          添加环境 IP
        </Button>
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          一个输入框填写一个地址；顺序用于任务分配，支持 IPv4 和 IPv6。
        </p>
        {error ? <Alert type="error" showIcon title={error} /> : null}
      </div>
    </ActionDialog>
  );
}

export function EnvironmentAddressesField({
  addresses,
  disabled = false,
  description,
  validation = "address",
  allowEmpty = true,
  onChange,
  purpose = "task",
}: EnvironmentAddressOptions & {
  onChange: (addresses: string[]) => void;
  purpose?: "task" | "execution";
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div
      className="grid min-w-0 gap-2"
      aria-label={purpose === "task" ? "任务默认环境 IP" : "本次执行环境 IP"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">环境 IP / 地址</span>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          修改环境 IP
        </Button>
      </div>
      <ExecutionEnvironmentAddresses addresses={addresses} />
      <p className="m-0 text-xs leading-5 text-muted-foreground">{description}</p>
      {editing ? (
        <EnvironmentAddressesDialog
          addresses={addresses}
          validation={validation}
          allowEmpty={allowEmpty}
          disabled={disabled}
          title={purpose === "task" ? "修改任务默认环境 IP" : "修改执行环境 IP"}
          confirmLabel={purpose === "task" ? "保留到任务配置" : "使用这些 IP"}
          description={description}
          onClose={() => setEditing(false)}
          onSave={(values) => {
            onChange(values);
            setEditing(false);
          }}
        />
      ) : null}
    </div>
  );
}
