"use client";

import { Alert, Descriptions, Space, Typography } from "antd";
import { useState, useSyncExternalStore } from "react";
import { Button, Select } from "./ui";
import { copyTextToClipboard } from "@/lib/client-clipboard";
import { useToast } from "./ui-feedback";

const subscribeToOrigin = () => () => undefined;
const browserOrigin = () => window.location.origin;
const serverOrigin = () => "";

export function VersionCaseExecutionApi({
  projectId,
  versionId,
  versionName,
  stageId,
}: {
  projectId: string;
  versionId: string;
  versionName: string;
  stageId?: string | undefined;
}) {
  const [exampleKind, setExampleKind] = useState("testng");
  const [stageScoped, setStageScoped] = useState("version");
  const baseUrl = useSyncExternalStore(subscribeToOrigin, browserOrigin, serverOrigin);
  const toast = useToast();
  const versionEndpoint = `/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`;
  const endpoint = `${versionEndpoint}${stageScoped === "stage" && stageId ? `/stages/${encodeURIComponent(stageId)}` : ""}/case-executions`;
  const body = {
    ...(exampleKind === "testng"
      ? { className: "com.example.CheckoutTest" }
      : { caseId: "订单支付_001" }),
    environmentIp: "10.0.0.21",
  };
  const example = `curl --fail-with-body --request POST \\\n  '${baseUrl.replace(/\/$/u, "")}${endpoint}' \\\n  --header 'Authorization: Bearer <API_TOKEN>' \\\n  --header 'Content-Type: application/json' \\\n  --data '${JSON.stringify(body, null, 2)}'`;
  return (
    <div className="grid min-w-0 gap-4 p-4">
      <div>
        <Typography.Title level={4}>单用例执行 API</Typography.Title>
        <Typography.Paragraph type="secondary">
          当前版本：{versionName}。接口地址固定对应此项目和版本，支持普通用例与 DDT 用例。
        </Typography.Paragraph>
      </div>
      <Alert
        type="info"
        showIcon
        message="使用现有 API Token"
        description="创建执行需要项目 run.create 权限；查询结果需要 run.read，读取日志需要 log.read。浏览器登录用户也可通过同源请求调用。"
      />
      <div className="rounded-lg border border-border bg-muted p-3">
        <Typography.Text className="break-all font-mono">POST {endpoint}</Typography.Text>
      </div>
      <Typography.Title level={5}>必填参数</Typography.Title>
      <Descriptions column={1} size="small" bordered styles={{ label: { whiteSpace: "nowrap" } }}>
        <Descriptions.Item label="用例标识">
          className（普通用例的完整类路径）或 caseId（DDT 原始 CaseID）二选一，自动识别类型。
        </Descriptions.Item>
        <Descriptions.Item label="被测环境 IP">
          environmentIp：单个 IPv4 或 IPv6 地址。
        </Descriptions.Item>
      </Descriptions>
      <Typography.Title level={5}>默认配置</Typography.Title>
      <Descriptions column={1} size="small" bordered styles={{ label: { whiteSpace: "nowrap" } }}>
        <Descriptions.Item label="Adapter">
          默认开启。Suite Name 取项目名，Test Name 取“版本名 - 测试阶段名”，环境地址使用
          environmentIp。
        </Descriptions.Item>
        <Descriptions.Item label="执行机">
          自动从在线、兼容且具备所需能力的节点中调度；没有合适节点时返回明确错误。
        </Descriptions.Item>
      </Descriptions>
      <Typography.Title level={5}>选填参数</Typography.Title>
      <Descriptions column={1} size="small" bordered styles={{ label: { whiteSpace: "nowrap" } }}>
        <Descriptions.Item label="测试阶段 URL">
          默认自动定位。同一类路径或 DDT CaseID 跨阶段重复时，使用
          /stages/&#123;stageId&#125;/case-executions，正文不传阶段。
        </Descriptions.Item>
        <Descriptions.Item label="平台 ID 兼容">
          caseDefinitionId 可替代 className 精确指定普通用例；三种定位字段只能选择一种。
        </Descriptions.Item>
        <Descriptions.Item label="执行机限制">
          execution.runnerIds 或 execution.runnerGroupId 可选，二者不能同时填写。
        </Descriptions.Item>
        <Descriptions.Item label="Adapter 覆盖">
          execution.adapter.suiteName、testName 可选；普通用例可显式关闭 Adapter，DDT 必须开启。
        </Descriptions.Item>
        <Descriptions.Item label="其他策略">
          execution 内可选重跑策略、delaySeconds、priority、排队/领取/上传时限和
          artifactPatterns；用例执行超时由平台统一配置。
        </Descriptions.Item>
      </Descriptions>
      <Space wrap className="justify-between">
        <label className="flex min-w-0 items-center gap-2">
          示例类型{" "}
          <span className="w-40">
            <Select
              aria-label="执行 API 用例类型"
              value={exampleKind}
              onChange={(event) => setExampleKind(event.target.value)}
            >
              <option value="testng">普通用例</option>
              <option value="ddt">DDT 用例</option>
            </Select>
          </span>
        </label>
        {stageId ? (
          <label className="flex min-w-0 items-center gap-2">
            接口范围
            <span className="w-44">
              <Select
                aria-label="执行 API 接口范围"
                value={stageScoped}
                onChange={(event) => setStageScoped(event.target.value)}
              >
                <option value="version">版本内自动定位</option>
                <option value="stage">限定当前测试阶段</option>
              </Select>
            </span>
          </label>
        ) : null}
        <Button
          disabled={!baseUrl}
          onClick={() =>
            void copyTextToClipboard(example).then(
              () => toast.success("已复制调用示例"),
              () => toast.error("复制失败，请手动选择示例"),
            )
          }
        >
          复制调用示例
        </Button>
      </Space>
      <pre className="m-0 max-h-[480px] overflow-auto rounded-lg border border-border bg-muted p-4 text-xs leading-6">
        <code>{example}</code>
      </pre>
      <Typography.Paragraph type="secondary">
        调用示例只需用例定位和被测环境 IP。201 返回 batchId、statusUrl，
        使用相同令牌查询结果，建议间隔至少 2 秒；attempt
        创建后返回日志地址。执行记录显示于“单用例执行”。
      </Typography.Paragraph>
    </div>
  );
}
