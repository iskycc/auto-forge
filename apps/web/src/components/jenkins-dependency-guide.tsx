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
        description="将 Jenkins Agent 上构建的依赖压缩包直接上传到当前项目版本，供后续新建执行使用。"
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
                    请管理员在“平台设置 → 服务账号”签发 API Key，确保服务账号和令牌均拥有目标项目的{" "}
                    “管理项目”（<code>project.manage</code>）权限。在 Jenkins Credentials 中保存为
                    Secret text，凭据 ID 使用 <code>autoforge-api-key</code>
                    ，不要将密钥写入脚本或下载 URL。
                  </p>
                </GuideStep>
                <GuideStep number={3} title="发布依赖并核对当前版本">
                  <p className="m-0">
                    先构建好依赖压缩包，通过 filePath 指定工作区相对路径或当前 Agent
                    的绝对路径，再调用 <code>autoforgePublishDependencies</code>
                    。发布成功后刷新本页，在“依赖包”中核对最新文件。该操作替换当前版本依赖绑定；已创建批次继续使用其执行快照，旧上传文件沿用文件管理的引用保护。
                  </p>
                  <Button type="button" variant="secondary" onClick={() => setTab("pipeline")}>
                    查看 Pipeline 示例
                  </Button>
                </GuideStep>
                <Alert
                  type="info"
                  showIcon
                  title="从 Jenkins Agent 直接上传依赖文件"
                  description="插件在当前 Jenkins Agent 上读取文件，自动计算 SHA-256 和大小并流式上传。无需 archiveArtifacts、摘要脚本或 Artifact URL；Agent 必须能访问平台，执行节点后续从平台托管存储下载。此入口不更新 JDK、不导入测试用例，也不自动执行任务。"
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
                  description="示例放入有 agent 的 Pipeline steps 块，filePath 支持工作区相对路径和当前 Agent 的绝对路径。插件自动计算摘要、大小并上传，支持 ZIP、tar.gz 和 tgz；无需 Jenkins 归档或下载 URL。"
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
                  classNames={{ label: "w-40 whitespace-nowrap" }}
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
                      key: "filePath",
                      label: "filePath",
                      children:
                        "当前 Jenkins Agent 的文件路径：支持工作区相对路径，或 Linux／Windows 绝对路径（如 /opt/builds/dependencies.zip、D:/builds/dependencies.zip）。相对路径须位于工作区内，不支持通配符；Agent 账号需可读。摘要和大小自动计算。",
                    },
                  ]}
                />
                <Descriptions
                  title="选填参数"
                  classNames={{ label: "w-40 whitespace-nowrap" }}
                  size="small"
                  bordered
                  column={1}
                  items={[
                    {
                      key: "fileName",
                      label: "fileName",
                      children: "默认使用本地文件名；仅在需要改名时填写，扩展名须与压缩格式一致。",
                    },
                    {
                      key: "archiveFormat",
                      label: "archiveFormat",
                      children: "默认根据文件扩展名自动识别 zip 或 tar.gz，无需手工填写。",
                    },
                  ]}
                />
                <Alert
                  type="info"
                  showIcon
                  title="发布结果"
                  description="成功返回 projectId、projectVersionId、version、assetId。Jenkins 控制台展示文件摘要、大小和资产编号；拒绝时显示平台返回的具体原因。"
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
