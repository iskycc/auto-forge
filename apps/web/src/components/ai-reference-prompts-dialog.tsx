"use client";

import { Alert, Button, Form, Input, Modal, Space, Typography } from "antd";
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { aiReferencePromptSchema } from "@autoforge/contracts";
import type { z } from "zod";
import { useState } from "react";

type ReferencePrompt = z.infer<typeof aiReferencePromptSchema>;
export function AiReferencePromptsDialog({
  value: prompts = [],
  disabled,
  onChange,
}: {
  value?: ReferencePrompt[];
  disabled: boolean;
  onChange?: (prompts: ReferencePrompt[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [form] = Form.useForm<{ prompts: ReferencePrompt[] }>();
  return (
    <>
      <Button
        disabled={disabled}
        onClick={() => {
          form.setFieldsValue({ prompts: structuredClone(prompts) });
          setError("");
          setOpen(true);
        }}
      >
        参考提示词（{prompts.length}）
      </Button>
      <Modal
        forceRender
        open={open}
        title="AI 分析参考提示词"
        width={720}
        onCancel={() => setOpen(false)}
        styles={{ body: { maxHeight: "60vh", overflowY: "auto", paddingRight: 8 } }}
        footer={
          <Space wrap>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button
              type="primary"
              onClick={async () => {
                try {
                  const values = await form.validateFields();
                  const next = (values.prompts ?? []).map((prompt) =>
                    aiReferencePromptSchema.parse(prompt),
                  );
                  if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 20000)
                    throw new Error("参考提示词合计超过 20,000 UTF-8 字节，请精简内容。");
                  onChange?.(next);
                  setOpen(false);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "请完善提示词内容。");
                }
              }}
            >
              应用到配置
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%", minWidth: 0 }}>
          <Alert
            showIcon
            type="info"
            title="每次分析均附带全部参考提示词"
            description="用于补充业务规则和常见问题，不能覆盖工具权限及精简输出格式。应用后请保存模型配置；请勿填写密码或密钥。最多 20 条，合计 20,000 UTF-8 字节。"
          />
          {error ? <Alert showIcon type="error" title={error} /> : null}
          <Form form={form} layout="vertical" style={{ width: "100%" }}>
            <Form.List name="prompts">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field, index) => (
                    <div key={field.key} className="mb-4 rounded-lg border border-border p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <Typography.Text strong>参考 {index + 1}</Typography.Text>
                        <Button
                          type="text"
                          icon={<MinusCircleOutlined />}
                          aria-label={`删除参考 ${index + 1}`}
                          onClick={() => remove(field.name)}
                        >
                          删除
                        </Button>
                      </div>
                      <Form.Item
                        name={[field.name, "title"]}
                        label="提示词标题"
                        rules={[{ required: true, whitespace: true, message: "请输入标题。" }]}
                      >
                        <Input maxLength={60} placeholder="例如：环境瞬时波动" />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "content"]}
                        label="提示词内容"
                        rules={[{ required: true, whitespace: true, message: "请输入参考内容。" }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Input.TextArea
                          rows={3}
                          maxLength={1500}
                          showCount
                          placeholder="填写需要 AI 参考的业务规则或排查经验"
                        />
                      </Form.Item>
                    </div>
                  ))}
                  <Button
                    block
                    type="dashed"
                    icon={<PlusOutlined />}
                    disabled={fields.length >= 20}
                    onClick={() => add({ title: "", content: "" })}
                  >
                    添加参考提示词
                  </Button>
                </>
              )}
            </Form.List>
          </Form>
        </Space>
      </Modal>
    </>
  );
}
