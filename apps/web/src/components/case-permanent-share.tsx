"use client";
import { LoadingIcon } from "@/components/ui/loading-icon";

import { Notice } from "@/components/ui/notice";

import { LinkButton } from "@/components/ui/link-button";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Check, Copy, ExternalLink, Link2 } from "lucide-react";
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
    <div className={cn("case-share-control", casePermanentShareStyles["case-share-control"])}>
      <Button disabled={pending} onClick={() => void createShare()} type="button">
        {pending ? (
          <LoadingIcon size={16} aria-hidden="true" />
        ) : (
          <Link2 size={16} aria-hidden="true" />
        )}
        {shareUrl ? "重新获取链接" : "匿名分享"}
      </Button>
      {shareUrl ? (
        <div
          className={cn("case-share-result", casePermanentShareStyles["case-share-result"])}
          role="status"
        >
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
          <LinkButton
            aria-label="在新窗口打开永久分享链接"
            className={"ui-button ui-button-ghost ui-button-compact"}
            href={shareUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink size={15} />
          </LinkButton>
        </div>
      ) : null}
      {error ? (
        <Notice
          tone="error"
          className={cn(
            "form-error case-share-error",
            uiPatterns["form-error"],
            casePermanentShareStyles["case-share-error"],
          )}
          role="alert"
        >
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

const casePermanentShareStyles = {
  "case-share-control": "relative flex items-center gap-2",
  "case-share-error":
    "absolute top-[calc(100%_+_8px)] right-0 w-max max-w-[360px] border border-solid border-border rounded-lg py-2 px-2.5 bg-card shadow-xs",
  "case-share-result":
    "absolute z-12 top-[calc(100%_+_8px)] right-0 flex w-max max-w-[420px] items-center gap-1 border border-solid border-border rounded-lg [padding:7px_8px_7px_12px] bg-card shadow-xs text-muted-foreground text-xs",
} as const;
