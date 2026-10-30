"use client";
import { useState } from "react";
import { App, Button, Dropdown, Input, Modal, Typography } from "antd";
import { CopyOutlined, DownOutlined } from "@ant-design/icons";
import { logArchiveDownloadLinksSchema } from "@autoforge/contracts";
import { readApiError } from "@/lib/client-api";
import { copyTextToClipboard } from "@/lib/client-clipboard";
import {
  archiveDownloadCommands,
  type ArchiveDownloadFormat,
} from "@/lib/log-archive-download-commands";
import { CopyableText } from "./ui/copyable-text";

export function ArchiveDownloadCopy({
  archiveIds,
  onCopied,
}: {
  archiveIds: string[];
  onCopied(): void;
}) {
  const { message } = App.useApp();
  const [pending, setPending] = useState(false);
  const [fallback, setFallback] = useState("");
  async function copy(format: ArchiveDownloadFormat) {
    if (pending || !archiveIds.length) return;
    setPending(true);
    try {
      const response = await fetch("/api/v1/settings/log-archives/download-links", {
        method: "POST",
        signal: AbortSignal.timeout(30000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archiveIds }),
      });
      if (!response.ok) throw await readApiError(response, "下载链接生成失败，请刷新后重试。");
      const links = logArchiveDownloadLinksSchema.parse(await response.json());
      const commands = archiveDownloadCommands(links.items, format);
      try {
        await copyTextToClipboard(commands);
        void message.success(
          `已复制 ${links.items.length} 卷的${format === "links" ? "下载直链" : ` ${format} 命令`}。`,
        );
      } catch {
        setFallback(commands);
      }
      onCopied();
    } catch (cause) {
      void message.error(cause instanceof Error ? cause.message : "下载链接生成失败。");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Dropdown
        disabled={!archiveIds.length || pending}
        menu={{
          items: [
            { key: "wget", label: "复制 wget 命令" },
            { key: "curl", label: "复制 curl 命令" },
            { key: "links", label: "复制下载直链" },
          ],
          onClick: ({ key }) => void copy(key as ArchiveDownloadFormat),
        }}
      >
        <Button
          aria-label="复制下载方式"
          icon={<CopyOutlined />}
          disabled={!archiveIds.length || pending}
          loading={pending}
        >
          复制下载方式 <DownOutlined />
        </Button>
      </Dropdown>
      <Modal
        title="复制归档下载内容"
        open={Boolean(fallback)}
        onCancel={() => setFallback("")}
        footer={null}
        width={720}
      >
        <Typography.Paragraph>
          浏览器未允许自动复制，请点击复制图标或手动选择下方内容。
        </Typography.Paragraph>
        <CopyableText text={fallback}>复制全部内容</CopyableText>
        <Input.TextArea
          aria-label="归档下载命令或直链"
          readOnly
          value={fallback}
          autoSize={{ minRows: 5, maxRows: 12 }}
        />
      </Modal>
    </>
  );
}
