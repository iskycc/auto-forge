"use client";

import { Check, Copy, ExternalLink, Link2, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { readApiErrorMessage } from "@/lib/client-api";
import { copyTextToClipboard } from "@/lib/client-clipboard";

import { Button } from "./ui";

export function CasePermanentShare({ caseDefinitionId }: { caseDefinitionId: string }) {
  const [pending, setPending] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function createShare(): Promise<void> {
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/share`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "生成永久分享链接失败。"))!);
      }
      const payload = (await response.json()) as { shareUrl: string };
      setShareUrl(payload.shareUrl);
      await copyShareUrl(payload.shareUrl);
    } catch (shareFailure) {
      setError(shareFailure instanceof Error ? shareFailure.message : "生成永久分享链接失败。");
    } finally {
      setPending(false);
    }
  }

  async function copyShareUrl(url = shareUrl): Promise<void> {
    setError("");
    try {
      await copyTextToClipboard(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (copyFailure) {
      setCopied(false);
      setError(copyFailure instanceof Error ? copyFailure.message : "复制分享链接失败。");
    }
  }

  return (
    <div className="case-share-control">
      <Button disabled={pending} onClick={() => void createShare()} type="button">
        {pending ? (
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
        ) : (
          <Link2 size={16} aria-hidden="true" />
        )}
        {shareUrl ? "重新获取链接" : "匿名分享"}
      </Button>
      {shareUrl ? (
        <div className="case-share-result" role="status">
          <span>永久只读链接已生成{copied ? "并复制" : ""}</span>
          <Button
            aria-label="复制永久分享链接"
            onClick={() => void copyShareUrl()}
            size="compact"
            type="button"
            variant="ghost"
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </Button>
          <a
            aria-label="在新窗口打开永久分享链接"
            className="ui-button ui-button-ghost ui-button-compact"
            href={shareUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink size={15} />
          </a>
        </div>
      ) : null}
      {error ? (
        <span className="form-error case-share-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
