"use client";

import { Alert, Button, Checkbox, Form, Input, InputNumber, Space, Typography } from "antd";
import { useEffect, useState } from "react";
import {
  nodeExporterSourceSchema,
  postgresStorageCapacitySchema,
  storageMonitoringConfigurationSchema,
  type NodeExporterSource,
  type StorageMonitoringConfiguration,
  type StorageMonitoringTarget,
} from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { readApiError } from "@/lib/client-api";
import { formatDiskBytes } from "@/lib/runner-disk";

export function StorageMonitoringSettings({
  target,
  onSaved,
}: {
  target: StorageMonitoringTarget;
  onSaved(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>配置磁盘监控</Button>
      {open ? (
        <MonitoringDialog target={target} onClose={() => setOpen(false)} onSaved={onSaved} />
      ) : null}
    </>
  );
}

function MonitoringDialog({
  target,
  onClose,
  onSaved,
}: {
  target: StorageMonitoringTarget;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [form] = Form.useForm<NodeExporterSource>();
  const kind = target.kind;
  const databaseId = target.kind === "logs" ? target.databaseId : undefined;
  const [configuration, setConfiguration] = useState<StorageMonitoringConfiguration>();
  const [enabled, setEnabled] = useState(false);
  const [pendingAction, setPendingAction] = useState<"check" | "save" | null>(null);
  const pending = pendingAction !== null;
  const [error, setError] = useState("");
  const [checked, setChecked] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ kind, ...(databaseId ? { databaseId } : {}) });
    void (async () => {
      try {
        const response = await fetch(`/api/v1/settings/storage-monitoring?${query}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          cache: "no-store",
        });
        if (!response.ok) throw await readApiError(response, "读取监控配置失败。");
        const value = storageMonitoringConfigurationSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setConfiguration(value);
        setEnabled(value.source !== null);
        form.setFieldsValue(value.source ?? { port: 9100, tls: false, mountpoint: "/pgdata" });
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取配置失败。");
      }
    })();
    return () => controller.abort();
  }, [kind, databaseId, form]);
  async function submit(action: "check" | "save") {
    if (pending || !configuration) return;
    setPendingAction(action);
    setError("");
    setChecked("");
    try {
      const source = enabled ? nodeExporterSourceSchema.parse(await form.validateFields()) : null;
      const save = action === "save";
      const response = await fetch(`/api/v1/settings/storage-monitoring${save ? "" : "/check"}`, {
        method: save ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify(save ? { ...configuration, source } : source),
      });
      if (!response.ok)
        throw await readApiError(response, save ? "保存监控配置失败。" : "监控连接检查失败。");
      if (save) {
        await onSaved();
        onClose();
      } else {
        const sample = postgresStorageCapacitySchema.parse(await response.json());
        if (sample.status !== "available") throw new Error(sample.detail);
        setChecked(`连接成功，数据卷当前可用 ${formatDiskBytes(sample.availableBytes!)}。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请检查表单内容。");
    } finally {
      setPendingAction(null);
    }
  }
  return (
    <ActionDialog
      open
      title="配置磁盘监控"
      onClose={onClose}
      closeDisabled={pending}
      className="w-[min(600px,calc(100vw-3rem))]"
      footer={
        <Space>
          <Button onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button
            aria-label="检查连接"
            loading={pendingAction === "check"}
            disabled={!configuration || !enabled || pending}
            onClick={() => void submit("check")}
          >
            检查连接
          </Button>
          <Button
            type="primary"
            aria-label="保存监控配置"
            loading={pendingAction === "save"}
            disabled={!configuration || pending}
            onClick={() => void submit("save")}
          >
            保存监控配置
          </Button>
        </Space>
      }
    >
      <div className="grid min-w-0 gap-4">
        <Typography.Paragraph className="!m-0">
          在数据库所在机器启动 Node
          Exporter，读取该数据卷余量。主库和每台日志服务器分别配置，保存后立即生效。
        </Typography.Paragraph>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {checked ? <Alert type="success" showIcon title={checked} /> : null}
        <Checkbox
          checked={enabled}
          disabled={!configuration || pending}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setChecked("");
          }}
        >
          启用 Node Exporter 磁盘监控
        </Checkbox>
        <Form
          form={form}
          layout="vertical"
          disabled={!configuration || pending || !enabled}
          onValuesChange={() => setChecked("")}
        >
          <div className="grid grid-cols-2 gap-x-4">
            <Form.Item
              name="host"
              label="监控 IP / 主机名"
              rules={[{ required: enabled, message: "请输入监控地址。" }]}
            >
              <Input maxLength={255} placeholder="例如：10.20.0.13" />
            </Form.Item>
            <Form.Item name="port" label="监控端口" rules={[{ required: enabled }]}>
              <InputNumber min={1} max={65535} precision={0} className="!w-full" />
            </Form.Item>
          </div>
          <Form.Item name="tls" valuePropName="checked">
            <Checkbox>使用 HTTPS（默认使用可信内网 HTTP）</Checkbox>
          </Form.Item>
          <Form.Item
            name="mountpoint"
            label="数据卷挂载点"
            rules={[{ required: enabled }]}
            extra="部署模板默认 /pgdata；接入已有宿主机监控时填写该数据盘的实际挂载点，例如 /opt。"
          >
            <Input maxLength={1024} placeholder="/pgdata" />
          </Form.Item>
        </Form>
      </div>
    </ActionDialog>
  );
}
