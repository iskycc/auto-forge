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

export function RunBatchPermanentShare({
  batchId,
  sequenceNumber,
}: {
  batchId: string;
  sequenceNumber: number;
}) {
  const [pending, setPending] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function generate(): Promise<void> {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/run-batches/${encodeURIComponent(batchId)}/share`, {
        method: "POST",
      });
      const errorMessage = await readApiErrorMessage(response, "生成永久分享链接失败。");
      if (errorMessage) throw new Error(errorMessage);
      const payload = (await response.json()) as { shareUrl: string };
      setShareUrl(payload.shareUrl);
      await copy(payload.shareUrl);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "生成永久分享链接失败。");
    } finally {
      setPending(false);
    }
  }

  async function copy(url = shareUrl): Promise<void> {
    setError("");
    try {
      await copyTextToClipboard(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (problem) {
      setCopied(false);
      setError(problem instanceof Error ? problem.message : "复制分享链接失败。");
    }
  }

  return (
    <span className={cn("run-share-action", runBatchPermanentShareStyles["run-share-action"])}>
      <Button
        aria-label={`生成批次 #${sequenceNumber} 永久分享链接`}
        className={cn("compact-button", uiPatterns["compact-button"])}
        disabled={pending}
        onClick={() => void generate()}
        size="compact"
        title={error || "生成免登录永久只读链接"}
        type="button"
        variant="ghost"
      >
        {pending ? <LoadingIcon size={14} /> : <Link2 size={14} />}
        {shareUrl ? "重新生成" : "分享"}
      </Button>
      {shareUrl ? (
        <>
          <Button
            aria-label={`复制批次 #${sequenceNumber} 永久分享链接`}
            onClick={() => void copy()}
            size="compact"
            title={copied ? "已复制" : "复制链接"}
            type="button"
            variant="ghost"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
          <LinkButton
            aria-label={`打开批次 #${sequenceNumber} 永久分享链接`}
            className={"ui-button ui-button-ghost ui-button-compact"}
            href={shareUrl}
            rel="noreferrer"
            target="_blank"
            title="匿名打开"
          >
            <ExternalLink size={14} />
          </LinkButton>
          <span
            aria-live="polite"
            className={cn("visually-hidden", uiPatterns["visually-hidden"])}
            role="status"
          >
            {copied ? "永久分享链接已复制" : error}
          </span>
        </>
      ) : null}
      {error ? (
        <Notice
          tone="error"
          className={cn(
            "form-error run-share-error",
            uiPatterns["form-error"],
            runBatchPermanentShareStyles["run-share-error"],
          )}
          role="alert"
        >
          {error}
        </Notice>
      ) : null}
    </span>
  );
}

const runBatchPermanentShareStyles = {
  "run-share-action": "relative inline-flex items-center gap-[calc(8px_/_2)]",
  "run-share-error":
    "absolute z-12 top-[calc(100%_+_8px)] right-0 w-max max-w-[min(360px,_60vw)] border border-solid border-border rounded-lg py-2 px-2.5 bg-card shadow-xs whitespace-normal",
} as const;
