"use client";

import {
  Alert,
  Button,
  Card,
  Flex,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { DatabaseOutlined, PlusOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type {
  LogDatabase,
  LogDatabasePage,
  RegisterLogDatabaseInput,
  RegisterDailyLogServerInput,
} from "@autoforge/contracts";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui-feedback";
import { readApiError } from "@/lib/client-api";

export function LogDatabases({
  initial,
  canManage,
}: {
  initial: LogDatabasePage;
  canManage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LogDatabase>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  async function act(key: string, url: string, method: string, body?: unknown) {
    if (pending) return;
    setPending(key);
    setError("");
    try {
      const response = await fetch(url, {
        method,
        ...(body !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      if (!response.ok) throw await readApiError(response, "日志数据库操作失败。");
      toast.success(
        key.startsWith("check:")
          ? "连接与日志库身份验证通过。"
          : "写入库已切换，新批次立即使用新配置。已有批次保持原存储。",
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "日志数据库操作失败。");
    } finally {
      setPending(undefined);
    }
  }
  function select(databaseId: string | null) {
    void act(`select:${databaseId}`, "/api/v1/settings/log-databases/active", "PUT", {
      databaseId,
      revision: initial.revision,
    });
  }
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-label="日志数据库管理">
      <Alert
        type="info"
        showIcon
        title="按日自动建库，写入配置实时生效"
        description="新批次首次上传时固定日志服务器；按每条日志的北京时间日期自动创建独立数据库，跨日执行自动分库并合并读取。切换服务器仅影响新批次。旧版单库保留历史读取。"
      />
      <Flex justify="space-between" align="center" gap="middle" wrap>
        <Typography.Text type="secondary">
          独立存储执行日志正文，主平台数据库保存库标识及确认水位。
        </Typography.Text>
        {canManage ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
            添加日志服务器
          </Button>
        ) : null}
      </Flex>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      <Typography.Text>
        当前写入：
        {initial.activeDatabaseId
          ? (initial.items.find((item) => item.id === initial.activeDatabaseId)?.name ??
            initial.activeDatabaseId)
          : "节点本地日志"}
      </Typography.Text>
      <Card
        size="small"
        title={
          <Space>
            <DatabaseOutlined />
            <span>节点本地日志</span>
          </Space>
        }
        extra={!initial.activeDatabaseId ? <Tag color="processing">当前写入</Tag> : null}
      >
        <Flex justify="space-between" align="center" gap="middle" wrap>
          <Typography.Text type="secondary">
            兼容现有批次 SQLite 存储，由原日志节点提供读取。
          </Typography.Text>
          {canManage && initial.activeDatabaseId ? (
            <Button
              disabled={Boolean(pending)}
              loading={pending === "select:null"}
              onClick={() => select(null)}
            >
              切换为本地写入
            </Button>
          ) : null}
        </Flex>
      </Card>
      {initial.items.map((database) => (
        <Card
          key={database.id}
          size="small"
          title={
            <Space wrap>
              <DatabaseOutlined />
              <span>{database.name}</span>
              <Tag>{database.storageMode === "daily" ? "每日独立数据库" : "旧版单库"}</Tag>
              {database.active ? <Tag color="processing">当前写入</Tag> : <Tag>保留历史读取</Tag>}
            </Space>
          }
        >
          <Flex justify="space-between" align="center" gap="middle" wrap>
            <div className="min-w-0 flex-1 break-all">
              <Typography.Paragraph className="!mb-1">{database.address}</Typography.Paragraph>
              <Typography.Text type="secondary">
                {database.batchCount.toLocaleString()} 个批次 ·{" "}
                {(database.storedBytes / 1024 / 1024).toFixed(2)} MiB 日志正文
              </Typography.Text>
              <Typography.Paragraph type="secondary" className="!mb-0 !mt-1">
                库标识：{database.id}
              </Typography.Paragraph>
            </div>
            {canManage ? (
              <Space wrap>
                <Button disabled={Boolean(pending)} onClick={() => setEditing(database)}>
                  修改连接
                </Button>
                <Button
                  disabled={Boolean(pending)}
                  loading={pending === `check:${database.id}`}
                  onClick={() =>
                    void act(
                      `check:${database.id}`,
                      `/api/v1/settings/log-databases/${database.id}/check`,
                      "POST",
                    )
                  }
                >
                  检查连接
                </Button>
                {!database.active && database.storageMode === "daily" ? (
                  <Button
                    disabled={Boolean(pending)}
                    loading={pending === `select:${database.id}`}
                    onClick={() => select(database.id)}
                  >
                    设为写入库
                  </Button>
                ) : null}
              </Space>
            ) : null}
          </Flex>
        </Card>
      ))}
      {!initial.items.length ? (
        <Typography.Text type="secondary">
          尚未登记独立日志库。添加并检查数据库后，可设为新批次的写入库。
        </Typography.Text>
      ) : null}
      {initial.nextCursor ? (
        <Link
          href={`/settings/platform?section=logs&logCursor=${encodeURIComponent(initial.nextCursor)}`}
        >
          下一页日志数据库
        </Link>
      ) : null}
      {adding ? (
        <RegisterLogDatabase
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            router.refresh();
            toast.success("日志数据库已登记，可检查连接并设为写入库。");
          }}
        />
      ) : null}
      {editing ? (
        <RegisterLogDatabase
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            router.refresh();
            toast.success("日志库连接已更新，库标识和历史归属保持不变。");
          }}
        />
      ) : null}
    </div>
  );
}

function RegisterLogDatabase({
  onClose,
  onSaved,
  initial,
}: {
  onClose(): void;
  onSaved(): void;
  initial?: LogDatabase;
}) {
  const legacy = initial && initial.storageMode !== "daily";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(input: RegisterLogDatabaseInput | RegisterDailyLogServerInput) {
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        initial ? `/api/v1/settings/log-databases/${initial.id}` : "/api/v1/settings/log-databases",
        {
          method: initial ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw await readApiError(response, "日志数据库登记失败。");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "日志数据库登记失败。");
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      title={initial ? "修改日志库连接" : "添加日志服务器"}
      onClose={onClose}
      closeDisabled={pending}
    >
      <div className="w-[600px] max-w-full p-6">
        <Typography.Title level={3}>
          {initial ? "修改日志库连接" : "添加日志服务器"}
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          {initial
            ? "新连接必须保留已有日志库，平台会验证历史库身份。密码不回显，请重新填写；每日库前缀不能修改。"
            : "填写独立 PostgreSQL 服务的管理员账号（例如 postgres 或 root），需有 CREATEDB 权限。平台自动创建每日数据库，密码加密保存；不需要提前手工建库。"}
        </Typography.Paragraph>
        {error ? <Alert type="error" showIcon title={error} className="!mb-4" /> : null}
        <Form
          layout="vertical"
          onFinish={submit}
          disabled={pending}
          requiredMark={false}
          initialValues={{
            port: 5432,
            maintenanceDatabase: "postgres",
            databasePrefix: "autoforge_logs",
            sslMode: "disable",
            username: "postgres",
            ...initial?.server,
            name: initial?.name,
          }}
        >
          <Form.Item
            label="日志库名称"
            name="name"
            rules={[{ required: true, whitespace: true, message: "请输入日志库名称。" }]}
          >
            <Input maxLength={120} placeholder="例如：日志库 2026-10" />
          </Form.Item>
          {legacy ? (
            <Form.Item
              label="PostgreSQL 连接地址"
              name="databaseUrl"
              rules={[{ required: true, message: "请输入 PostgreSQL 连接地址。" }]}
              extra="例如 postgres://log_user:密码@10.20.0.13:5433/autoforge_logs；账号需要该库的建表及读写权限。"
            >
              <Input.Password autoComplete="new-password" maxLength={4096} />
            </Form.Item>
          ) : (
            <>
              <Flex gap="middle">
                <Form.Item
                  label="PostgreSQL 主机 / IP"
                  name="host"
                  className="flex-1"
                  rules={[{ required: true, message: "请输入日志服务器主机。" }]}
                >
                  <Input placeholder="10.20.0.13" />
                </Form.Item>
                <Form.Item label="端口" name="port" rules={[{ required: true }]}>
                  <InputNumber min={1} max={65535} />
                </Form.Item>
              </Flex>
              <Flex gap="middle">
                <Form.Item
                  label="管理员用户名"
                  name="username"
                  className="flex-1"
                  rules={[{ required: true }]}
                >
                  <Input autoComplete="off" />
                </Form.Item>
                <Form.Item
                  label="管理员密码"
                  name="password"
                  className="flex-1"
                  rules={[{ required: true, message: "请填写管理员密码。" }]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              </Flex>
              <Flex gap="middle">
                <Form.Item
                  label="维护数据库"
                  name="maintenanceDatabase"
                  className="flex-1"
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
                <Form.Item label="SSL" name="sslMode" className="flex-1">
                  <Select
                    options={[
                      { value: "disable", label: "关闭" },
                      { value: "require", label: "要求加密" },
                      { value: "verify-full", label: "验证证书及主机" },
                    ]}
                  />
                </Form.Item>
              </Flex>
              <Form.Item
                label="每日库名前缀"
                name="databasePrefix"
                extra="实际库名：前缀_服务器标识_YYYYMMDD，按北京时间划分。"
                rules={[{ required: true }]}
              >
                <Input disabled={Boolean(initial)} />
              </Form.Item>
            </>
          )}
          <Flex justify="flex-end" gap="small">
            <Button onClick={onClose} disabled={pending}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={pending}>
              {initial ? "保存连接" : "登记数据库"}
            </Button>
          </Flex>
        </Form>
      </div>
    </Dialog>
  );
}
