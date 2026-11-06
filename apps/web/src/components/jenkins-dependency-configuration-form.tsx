"use client";
import { Alert, Button, Flex, Form, Input, Typography, type FormInstance } from "antd";
import { Plus, Trash2 } from "lucide-react";
import type { SaveJenkinsDependencyConfiguration } from "@autoforge/contracts";

export function JenkinsDependencyConfigurationForm({
  form,
  active,
  busy,
  apiTokenConfigured,
  onSave,
  onChange,
}: {
  form: FormInstance<SaveJenkinsDependencyConfiguration>;
  active: boolean;
  busy: boolean;
  apiTokenConfigured: boolean;
  onSave: (values: SaveJenkinsDependencyConfiguration) => void;
  onChange: () => void;
}) {
  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark="optional"
      onFinish={onSave}
      onValuesChange={onChange}
      disabled={busy || active}
    >
      {active ? (
        <Alert
          className="mb-4"
          type="info"
          showIcon
          title="当前构建结束或完成提交核对后，才能修改配置。"
        />
      ) : null}
      <Form.Item
        name="jobUrl"
        label="Jenkins 任务地址"
        rules={[{ required: true, message: "请填写任务地址" }]}
        extra="支持文件夹任务，例如 https://jenkins.example/job/folder/job/update-dependencies/"
      >
        <Input
          autoComplete="off"
          placeholder="https://jenkins.example/job/update-dependencies/"
          maxLength={2048}
        />
      </Form.Item>
      <div className="grid min-w-0 grid-cols-2 gap-x-4">
        <Form.Item
          name="username"
          label="用户名"
          rules={[{ required: true, message: "请填写用户名" }]}
        >
          <Input autoComplete="off" maxLength={256} />
        </Form.Item>
        <Form.Item
          name="apiToken"
          label="API 密钥"
          rules={[{ required: !apiTokenConfigured, message: "首次配置请填写 Jenkins API Token" }]}
          extra={
            apiTokenConfigured ? "已保存；留空保留原密钥。" : "填写 Jenkins 用户的 API Token。"
          }
        >
          <Input.Password autoComplete="new-password" maxLength={4096} />
        </Form.Item>
      </div>
      <Form.List name="parameters">
        {(fields, { add, remove }) => (
          <div className="grid gap-3">
            <Flex align="center" justify="space-between" wrap gap="small">
              <Typography.Text strong>构建参数</Typography.Text>
              <Button
                icon={<Plus size={14} />}
                disabled={active || busy || fields.length >= 100}
                onClick={() => add({ name: "", value: "" })}
              >
                添加参数
              </Button>
            </Flex>
            <Typography.Text type="secondary">
              参数名须与 Jenkins 中的参数化构建定义一致；值允许留空。
            </Typography.Text>
            {fields.map((field, index) => (
              <div
                key={field.key}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_32px] items-start gap-3 rounded-lg border border-border bg-muted/20 p-3"
              >
                <Form.Item
                  name={[field.name, "name"]}
                  label={`参数名 ${index + 1}`}
                  rules={[{ required: true, message: "请填写参数名" }]}
                  className="!mb-0"
                >
                  <Input maxLength={128} />
                </Form.Item>
                <Form.Item
                  name={[field.name, "value"]}
                  label={`参数值 ${index + 1}`}
                  className="!mb-0"
                >
                  <Input.TextArea
                    rows={1}
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    maxLength={16000}
                  />
                </Form.Item>
                <Button
                  className="self-end"
                  aria-label={`删除参数 ${index + 1}`}
                  icon={<Trash2 size={15} />}
                  onClick={() => remove(field.name)}
                />
              </div>
            ))}
          </div>
        )}
      </Form.List>
    </Form>
  );
}
