"use client";

import { Alert, Collapse, Tag, Typography } from "antd";
import { CopyableText } from "./ui/copyable-text";
import { useClientReadiness } from "./ui/use-client-readiness";
import { Download, PlugZap } from "lucide-react";
import { groovyStringLiteral } from "@/lib/jenkins-pipeline-guide";

export function JenkinsTaskGuide({
  suiteId,
  baseUrl,
}: {
  suiteId: string;
  baseUrl: string | undefined;
}) {
  const clientReady = useClientReadiness();
  const browserBaseUrl = clientReady ? window.location.origin : "";
  const pipeline =
    `withCredentials([string(credentialsId: 'autoforge-api-key', variable: 'AUTOFORGE_API_KEY')]) {\n  def result = autoforgeRun(\n    baseUrl: ${groovyStringLiteral(baseUrl || browserBaseUrl || "https://autoforge.example")},\n    apiKey: env.AUTOFORGE_API_KEY,\n    suiteId: ${groovyStringLiteral(suiteId)}\n  )\n  currentBuild.description = "AutoForge: $` +
    `{result.totalPassed}/$` +
    `{result.totalCases}"\n}`;
  return (
    <section aria-label="Jenkins 对接指导" className="min-w-0">
      <Collapse
        items={[
          {
            key: "jenkins",
            label: (
              <span className="flex items-center gap-2 font-semibold">
                <PlugZap size={17} />
                Jenkins 对接指导与插件下载
              </span>
            ),
            children: (
              <div className="grid min-w-0 gap-5">
                <Alert
                  type="info"
                  showIcon
                  title="浏览器公开执行与 Jenkins API 使用不同的认证方式"
                  description="此链接允许已登录用户执行；Jenkins 使用服务账号 API Key，仍需任务所属项目的 run.create、run.read、run.cancel 权限。公开链接不能作为 API Key 使用。"
                />
                <div className="grid min-w-0 gap-6">
                  {[
                    {
                      title: "安装内置插件",
                      content: (
                        <div className="grid gap-2">
                          <p className="m-0">
                            要求 Jenkins 2.479.3 或以上、Java 17 或以上，已安装 Pipeline: Step
                            API（700.v6e45cb_a_5a_a_21 或以上）与 Credentials Binding。进入“Manage
                            Jenkins → Plugins → Advanced settings → Deploy Plugin”，上传 HPI 并按
                            Jenkins 提示重启。
                          </p>
                          <div className="flex flex-wrap gap-4">
                            <Typography.Link href="/api/v1/integrations/jenkins/execution/download">
                              <Download size={14} className="mr-1 inline" />
                              执行插件（HPI）
                            </Typography.Link>
                            <Typography.Link href="/api/v1/integrations/jenkins/dependency-publisher/download">
                              <Download size={14} className="mr-1 inline" />
                              依赖发布插件（选装）
                            </Typography.Link>
                          </div>
                          <p className="m-0 text-xs text-muted-foreground">
                            插件随主平台版本交付，无需访问外网或单独查找 Release 包；离线 Jenkins
                            需预先准备上述插件依赖。
                          </p>
                        </div>
                      ),
                    },
                    {
                      title: "创建服务账号和 Jenkins 凭据",
                      content:
                        "请平台管理员在“系统设置 → 服务账号”签发 API Key，为服务账号及令牌授予任务所属项目的 run.create、run.read、run.cancel。将 Key 保存为 Jenkins 的 Secret text 凭据，ID 为 autoforge-api-key，禁止将密钥写入脚本。",
                    },
                    {
                      title: "复制 Pipeline 示例",
                      content: (
                        <div className="min-w-0">
                          <p className="mt-0">
                            任务 ID 已填入；确认 Jenkins Controller 能访问平台外部地址。
                          </p>
                          <div className="max-w-full overflow-x-auto rounded-lg border border-border bg-muted p-4">
                            <CopyableText text={pipeline} block className="!mb-0">
                              <pre className="!m-0 whitespace-pre text-xs leading-6">
                                {pipeline}
                              </pre>
                            </CopyableText>
                          </div>
                          <p className="mb-0 mt-3">
                            可选填{" "}
                            <Typography.Text code className="[&>code]:!text-xs">
                              {"environmentAddresses: ['192.0.2.10', '2001:db8::10']"}
                            </Typography.Text>
                            。支持填写一个或多个 IPv4／IPv6，只覆盖本次执行。省略时使用任务默认 IP。
                          </p>
                        </div>
                      ),
                    },
                    {
                      title: "执行与查看结果",
                      content:
                        "插件等待批次进入终态，再输出用例汇总、完整结果链接和实际通过率 ActualPassPercent。手动停止 Jenkins 会请求平台平滑终止并等待已领取用例完成上传。请读取 finalFailed 判断最终失败数量。选填 timeoutSeconds 可缩短 Jenkins 等待时间，仅等待超时不会自动取消平台任务。",
                    },
                  ].map((step, index) => (
                    <section key={step.title} className="flex min-w-0 items-start gap-3">
                      <Tag
                        color="blue"
                        className="!m-0 flex !size-7 shrink-0 items-center justify-center !rounded-full"
                      >
                        {index + 1}
                      </Tag>
                      <div className="min-w-0 flex-1">
                        <h4 className="mb-2 mt-0 text-sm font-semibold">{step.title}</h4>
                        <div className="min-w-0 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                          {step.content}
                        </div>
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            ),
          },
        ]}
      />
    </section>
  );
}
