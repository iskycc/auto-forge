"use client";

import { useState, type ReactNode } from "react";
import { Alert, Descriptions, Tabs, Tag, Typography } from "antd";
import { BookOpen, Download } from "lucide-react";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui/button";
import { CopyableText } from "./ui/copyable-text";
import { useClientReadiness } from "./ui/use-client-readiness";
import { dependencyPublicationPipeline } from "@/lib/jenkins-pipeline-guide";

export function JenkinsDependencyGuideButton({
  projectId,
  version,
  baseUrl,
}: {
  projectId: string;
  version: string | undefined;
  baseUrl: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" disabled={!version} onClick={() => setOpen(true)}>
        <BookOpen size={16} />
        Jenkins 接入指导
      </Button>
      <ActionDialog
        open={open}
        title="Jenkins 导入依赖接入快速指导"
        description="将 Jenkins 构建的依赖压缩包登记到当前项目版本，供后续新建执行使用。"
        onClose={() => setOpen(false)}
        className="!w-[min(860px,calc(100vw-64px))]"
      >
        {open && version ? (
          <JenkinsDependencyGuide projectId={projectId} version={version} baseUrl={baseUrl} />
        ) : null}
      </ActionDialog>
    </>
  );
}

function JenkinsDependencyGuide({
  projectId,
  version,
  baseUrl,
}: {
  projectId: string;
  version: string;
  baseUrl: string | undefined;
}) {
  const [tab, setTab] = useState("quick");
  const clientReady = useClientReadiness();
  const platformUrl = baseUrl || (clientReady ? window.location.origin : "");
  const pipeline = dependencyPublicationPipeline({ baseUrl: platformUrl, projectId, version });
  return (
    <div className="grid min-w-0 gap-4">
      <Descriptions
        size="small"
        bordered
        column={1}
        items={[
          {
            key: "project",
            label: "项目 ID",
            children: <CopyableText text={projectId} className="break-all" />,
          },
          {
            key: "version",
            label: "版本名称",
            children: <span className="wrap-anywhere">{version}</span>,
          },
        ]}
      />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "quick",
            label: "快速接入",
            children: (
              <div className="grid min-w-0 gap-4">
                <GuideStep number={1} title="下载并安装依赖发布插件">
                  <p className="m-0">
                    在 Jenkins 的 Manage Jenkins → Plugins → Advanced settings → Deploy Plugin 上传
                    HPI。需要 Jenkins 2.479.3+、Java 17+、Pipeline: Step API 700.v6e45cb_a_5a_a_21+
                    和 Credentials Binding；按 Jenkins 提示完成重启，离线环境需预先准备这些依赖。
                  </p>
                  <Typography.Link
                    className="inline-flex min-h-8 items-center gap-2"
                    href="/api/v1/integrations/jenkins/dependency-publisher/download"
                  >
                    <Download size={15} />
                    下载依赖发布插件（HPI）
                  </Typography.Link>
                </GuideStep>
                <GuideStep number={2} title="配置项目权限和 Jenkins 凭据">
                  <p className="m-0">
                    请管理员在“系统设置 → 服务账号”签发 API Key，确保服务账号和令牌均拥有目标项目的{" "}
                    <code>project.manage</code> 权限。在 Jenkins Credentials 中保存为 Secret
                    text，凭据 ID 使用 <code>autoforge-api-key</code>，不要将密钥写入脚本或下载
                    URL。
                  </p>
                </GuideStep>
                <GuideStep number={3} title="发布依赖并核对当前版本">
                  <p className="m-0">
                    先生成 ZIP 依赖包，再使用示例计算 SHA-256 和字节数、归档并调用{" "}
                    <code>autoforgePublishDependencies</code>
                    。构建成功后刷新本页，在“依赖包”中核对最新文件。该操作替换当前版本依赖，不保留旧依赖链接；已创建批次继续使用其执行快照。
                  </p>
                  <Button type="button" variant="secondary" onClick={() => setTab("pipeline")}>
                    查看 Pipeline 示例
                  </Button>
                </GuideStep>
                <Alert
                  type="info"
                  showIcon
                  title="只登记依赖链接，不上传 Jenkins 工作区文件"
                  description="Jenkins Controller 必须能访问平台，候选 Runner 必须能直接下载依赖 URL。插件不会转发 Jenkins 登录 Cookie；若 Artifact 需要认证，请提供 Runner 可访问的受控下载地址。此入口不更新 JDK、不导入测试用例，也不自动执行任务。"
                />
              </div>
            ),
          },
          {
            key: "pipeline",
            label: "Pipeline 示例",
            children: (
              <div className="grid min-w-0 gap-3">
                <Alert
                  type="info"
                  showIcon
                  title="当前项目、版本和平台地址已填入"
                  description="示例放入 Pipeline 的 steps 块，使用 Linux sha256sum 和 stat；请替换依赖包路径，先完成构建，再确认生成的 Artifact URL 可由所有候选 Runner 直接下载。ZIP 默认无需填写 fileName 或 archiveFormat。"
                />
                <div
                  className="max-w-full overflow-x-auto rounded-lg border border-solid border-border bg-muted p-4"
                  aria-label="依赖发布 Pipeline 示例"
                >
                  <CopyableText text={pipeline} block className="!mb-0">
                    <pre className="!m-0 whitespace-pre text-xs leading-6">{pipeline}</pre>
                  </CopyableText>
                </div>
              </div>
            ),
          },
          {
            key: "parameters",
            label: "参数说明",
            children: (
              <div className="grid min-w-0 gap-4">
                <Descriptions
                  title="必填参数"
                  size="small"
                  bordered
                  column={1}
                  items={[
                    {
                      key: "baseUrl",
                      label: "baseUrl",
                      children: "平台根地址，只支持 HTTP(S)，不要追加 /api/v1。",
                    },
                    {
                      key: "apiKey",
                      label: "apiKey",
                      children: "通过 Jenkins Secret text 凭据注入的 AutoForge API Key。",
                    },
                    {
                      key: "projectId",
                      label: "projectId",
                      children: "目标项目 ID，当前项目已填入。",
                    },
                    {
                      key: "version",
                      label: "version",
                      children:
                        "版本名称，当前所选版本已填入；不是版本 ID。不存在时会创建版本，已归档版本不可更新。",
                    },
                    {
                      key: "dependencyUrl",
                      label: "dependencyUrl",
                      children:
                        "候选 Runner 可直接下载的 HTTP(S) 压缩包地址，最长 2048 字符，不能携带用户名或密码。",
                    },
                    {
                      key: "sha256",
                      label: "sha256",
                      children: "实际压缩包的 SHA-256，64 位小写十六进制。",
                    },
                    {
                      key: "sizeBytes",
                      label: "sizeBytes",
                      children: "压缩包实际字节数，正整数，必须与下载内容一致。",
                    },
                  ]}
                />
                <Descriptions
                  title="选填参数"
                  size="small"
                  bordered
                  column={1}
                  items={[
                    {
                      key: "fileName",
                      label: "fileName",
                      children:
                        "默认 autoforge-dependencies.zip；非 ZIP 时显式填写匹配格式的 .tar.gz 或 .tgz 文件名。",
                    },
                    {
                      key: "archiveFormat",
                      label: "archiveFormat",
                      children: "默认 zip，可选 tar.gz；发布 tar.gz 时与 fileName 一起显式填写。",
                    },
                  ]}
                />
                <Alert
                  type="info"
                  showIcon
                  title="发布结果"
                  description="成功返回 projectId、projectVersionId、version、assetId。Jenkins 控制台提供“下载依赖包”链接；拒绝时显示平台返回的具体原因。"
                />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function GuideStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 items-start gap-3">
      <Tag
        color="blue"
        className="!m-0 flex !size-7 shrink-0 items-center justify-center !rounded-full"
      >
        {number}
      </Tag>
      <div className="grid min-w-0 flex-1 gap-2 text-sm leading-6 wrap-anywhere">
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        {children}
      </div>
    </section>
  );
}
