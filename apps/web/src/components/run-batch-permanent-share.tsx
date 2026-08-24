"use client";

import { Check, Copy, ExternalLink, Link2, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { readApiErrorMessage } from "@/lib/client-api";

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
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className="run-share-action">
      <Button
        aria-label={`生成批次 #${sequenceNumber} 永久分享链接`}
        className="compact-button"
        disabled={pending}
        onClick={() => void generate()}
        size="compact"
        title={error || "生成免登录永久只读链接"}
        type="button"
        variant="ghost"
      >
        {pending ? <LoaderCircle className="spin" size={14} /> : <Link2 size={14} />}
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
          <a
            aria-label={`打开批次 #${sequenceNumber} 永久分享链接`}
            className="ui-button ui-button-ghost ui-button-compact"
            href={shareUrl}
            rel="noreferrer"
            target="_blank"
            title="匿名打开"
          >
            <ExternalLink size={14} />
          </a>
        </>
      ) : null}
    </span>
  );
}
