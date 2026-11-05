"use client";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Switch,
  Typography,
  Row,
  Col,
} from "antd";
import { useState } from "react";
import type { AiModelConfigurationView } from "@autoforge/contracts";
import { readApiErrorMessage } from "@/lib/client-api";
import { AiReferencePromptsDialog } from "./ai-reference-prompts-dialog";

export function AiModelSettings({
  initial,
  canManage,
}: {
  initial: AiModelConfigurationView;
  canManage: boolean;
}) {
  const [form] = Form.useForm();
  const [revision, setRevision] = useState(initial.revision);
  const [keyConfigured, setKeyConfigured] = useState(initial.apiKeyConfigured);
  const [pending, setPending] = useState<"save" | "check" | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  async function submit(check = false) {
    try {
      const values = await form.validateFields();
      setPending(check ? "check" : "save");
      setNotice(null);
      const { apiKey, ...configuration } = values;
      const response = await fetch(`/api/v1/ai-analysis/configuration${check ? "/check" : ""}`, {
        method: check ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, configuration, ...(apiKey ? { apiKey } : {}) }),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "模型配置操作失败。"))!);
      const body = await response.json();
      if (!check) {
        setRevision(body.revision);
        setKeyConfigured(body.apiKeyConfigured);
        form.setFieldValue("apiKey", "");
      }
      setNotice({
        type: "success",
        message: check ? body.message : "已保存；新分析请求立即使用此配置，无需重启。",
      });
    } catch (error) {
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "请检查填写内容。",
      });
    } finally {
      setPending(null);
    }
  }
  return (
    <Card
      title="模型配置"
      extra={<Typography.Text type="secondary">OpenAI 兼容接口</Typography.Text>}
    >
      <Space orientation="vertical" size="large" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          title="后台初析，执行优先"
          description="AI 仅可读取分配的执行证据并保存初步结论，不会修改用例或执行结果。资源繁忙时自动退避；详细日志按预算分片，缺失证据会明确提示。"
        />
        {notice ? <Alert type={notice.type} title={notice.message} showIcon /> : null}
        <Form
          form={form}
          layout="vertical"
          disabled={!canManage || pending !== null}
          initialValues={{
            enabled: false,
            baseUrl: "",
            modelId: "",
            contextTokens: 32768,
            outputTokens: 2048,
            concurrency: 2,
            requestsPerMinute: 30,
            tokensPerMinute: 200000,
            timeoutSeconds: 90,
            maximumRetries: 3,
            maximumEvidenceMiB: 16,
            referencePrompts: [],
            ...initial.configuration,
          }}
        >
          <Form.Item>
            <label className="inline-flex min-h-8 cursor-pointer items-center gap-3">
              <Form.Item name="enabled" valuePropName="checked" noStyle>
                <Switch aria-label="启用 AI 初步分析" />
              </Form.Item>
              <Typography.Text>启用 AI 初步分析</Typography.Text>
            </label>
          </Form.Item>
          <Row gutter={[24, 0]}>
            <Col span={16}>
              <Form.Item
                name="baseUrl"
                label="API 根地址"
                extra="例如 http://model.internal:8000/v1，不填写 /chat/completions。"
                rules={[{ required: true, message: "请输入 API 根地址。" }]}
              >
                <Input placeholder="http://model.internal:8000/v1" autoComplete="off" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="modelId"
                label="模型 ID"
                rules={[{ required: true, message: "请输入模型 ID。" }]}
              >
                <Input placeholder="模型服务提供的模型标识" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="apiKey"
            label="API Key"
            extra={
              keyConfigured
                ? "已保存密钥；留空保留原值，输入新值则更新。"
                : "无鉴权内网端点可留空；密钥加密保存，不回显。"
            }
          >
            <Input.Password
              placeholder={keyConfigured ? "已配置，留空保留" : "输入 API Key"}
              autoComplete="new-password"
            />
          </Form.Item>
          <Row gutter={[24, 0]}>
            {[
              ["contextTokens", "上下文大小（tokens）", 8192, 2097152],
              ["outputTokens", "输出预算（tokens）", 512, 16384],
              ["concurrency", "端点共享并发", 1, 32],
              ["requestsPerMinute", "每分钟请求数（RPM）", 1, 10000],
              ["tokensPerMinute", "每分钟 Token 预算（TPM）", 4096, 10000000],
              ["timeoutSeconds", "单次响应期限（秒）", 10, 300],
              ["maximumRetries", "临时错误最大重试次数", 0, 8],
              ["maximumEvidenceMiB", "每例证据预算（MiB）", 1, 64],
            ].map(([name, label, min, max]) => (
              <Col span={12} key={String(name)}>
                <Form.Item
                  name={String(name)}
                  label={label}
                  rules={[{ required: true, message: "请输入配置值。" }]}
                >
                  <InputNumber
                    min={Number(min)}
                    max={Number(max)}
                    precision={0}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
              </Col>
            ))}
          </Row>
          <Form.Item
            name="referencePrompts"
            label="分析参考提示词"
            extra="每次批次和单例分析都会读取；应用后点击“保存配置”生效。"
          >
            <AiReferencePromptsDialog disabled={!canManage || pending !== null} />
          </Form.Item>
          <Space wrap>
            <Button type="primary" loading={pending === "save"} onClick={() => void submit()}>
              保存配置
            </Button>
            <Button loading={pending === "check"} onClick={() => void submit(true)}>
              检查连接
            </Button>
            <Typography.Text type="secondary">所有 Worker 共用模型并发及限流额度</Typography.Text>
          </Space>
        </Form>
      </Space>
    </Card>
  );
}
