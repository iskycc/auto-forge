"use client";

import { Alert, Button, Form, Input, Typography } from "antd";
import { useState } from "react";
import { registerUserInputSchema, type RegisterUserInput } from "@autoforge/contracts";
import { readApiError } from "@/lib/client-api";
import { authEntryValidationMessage } from "@/lib/auth-entry-validation";
import { registrationReturnPath } from "@/lib/registration-return-path";
import { useLoginDialog } from "./login-dialog-provider";

export function RegistrationForm({ returnTo }: { returnTo: string }) {
  const [form] = Form.useForm<RegisterUserInput>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { openLogin } = useLoginDialog();

  async function submit(values: RegisterUserInput) {
    if (pending) return;
    const parsed = registerUserInputSchema.safeParse({
      ...values,
      email: values.email?.trim() || undefined,
    });
    if (!parsed.success) {
      setError(authEntryValidationMessage(parsed.error.issues) ?? "请检查账号信息。");
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(15000),
      });
      const failure = await readApiError(response, "创建账号失败，请稍后重试。");
      if (failure) {
        if (failure.code === "USER_CONFLICT")
          form.setFields([{ name: "username", errors: [failure.message] }]);
        setError(authEntryValidationMessage(failure.details) ?? failure.message);
        return;
      }
      window.location.replace(registrationReturnPath(returnTo));
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === "TimeoutError"
          ? "创建账号请求超时。若账号已创建，可使用刚填写的账号和密码登录。"
          : "创建账号请求未完成，请检查网络连接后重试；也可尝试登录刚填写的账号。",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Form
      form={form}
      layout="vertical"
      size="middle"
      requiredMark={false}
      disabled={pending}
      onFinish={(values) => void submit(values)}
      className="[&_.ant-form-item]:mb-3 [&_.ant-form-item-label]:!pb-1"
      aria-label="创建本地账号"
    >
      {error ? <Alert type="error" showIcon title={error} className="mb-4" /> : null}
      <Form.Item
        name="username"
        label="用户名"
        rules={[{ required: true, message: "请输入用户名。" }]}
      >
        <Input autoComplete="username" maxLength={64} placeholder="3–64 位，以字母或数字开头" />
      </Form.Item>
      <div className="grid grid-cols-2 gap-4">
        <Form.Item
          name="displayName"
          label="显示名称"
          rules={[{ required: true, whitespace: true, message: "请输入显示名称。" }]}
        >
          <Input autoComplete="name" maxLength={120} placeholder="姓名或昵称" />
        </Form.Item>
        <Form.Item
          name="email"
          label="邮箱（可选）"
          rules={[{ type: "email", message: "请输入有效邮箱。" }]}
        >
          <Input autoComplete="email" maxLength={320} placeholder="可留空" />
        </Form.Item>
      </div>
      <Form.Item
        name="password"
        label="密码"
        rules={[{ required: true, message: "请设置密码。" }]}
        extra="12–128 位，包含字母、数字和特殊字符。"
      >
        <Input.Password autoComplete="new-password" maxLength={128} />
      </Form.Item>
      <Form.Item
        name="confirmPassword"
        label="确认密码"
        dependencies={["password"]}
        rules={[
          { required: true, message: "请再次输入密码。" },
          ({ getFieldValue }) => ({
            validator: (_, value: string) =>
              !value || getFieldValue("password") === value
                ? Promise.resolve()
                : Promise.reject(new Error("两次输入的密码不一致。")),
          }),
        ]}
      >
        <Input.Password autoComplete="new-password" maxLength={128} />
      </Form.Item>
      <Button
        type="primary"
        size="large"
        htmlType="submit"
        block
        loading={pending}
        aria-label="创建账号并登录"
      >
        创建账号并登录
      </Button>
      <div className="mt-4 flex items-center justify-center gap-1">
        <Typography.Text type="secondary">已有账号？</Typography.Text>
        <Button type="link" onClick={openLogin} disabled={pending} className="!h-8 !px-1 !py-0">
          登录现有账号
        </Button>
      </div>
    </Form>
  );
}
