"use client";
import { Disclosure } from "@/components/ui/disclosure";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useState } from "react";
import { z } from "zod";
import { javaSourceReferenceSchema } from "@autoforge/contracts";
import { readApiErrorMessage } from "@/lib/client-api";
import {
  browserCacheEpoch,
  readBrowserSnapshot,
  writeBrowserSnapshot,
} from "@/lib/browser-read-cache";
import { Button } from "./ui";

const sourceSchema = z
  .object({ reference: javaSourceReferenceSchema, content: z.string() })
  .nullable();

export function LazyCaseSource({
  caseDefinitionId,
  revision,
}: {
  caseDefinitionId: string;
  revision: number;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<z.infer<typeof sourceSchema>>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const epoch = browserCacheEpoch();
    const key = `case-source:v1:${caseDefinitionId}:${revision}`;
    async function load() {
      setError("");
      try {
        const cached = readBrowserSnapshot(key);
        if (cached !== undefined) {
          setSource(sourceSchema.parse(cached));
          return;
        }
        const response = await fetch(
          `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/source`,
          { signal: controller.signal, cache: "no-store" },
        );
        const message = await readApiErrorMessage(response, "读取源码失败。");
        if (message) throw new Error(message);
        const result = sourceSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setSource(result);
          writeBrowserSnapshot(key, result, epoch);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取源码失败。");
      }
    }
    void load();
    return () => controller.abort();
  }, [open, caseDefinitionId, revision, retry]);
  return (
    <Disclosure
      header={<>用例源码</>}
      className={cn("case-inspector-section", lazyCaseSourceStyles["case-inspector-section"])}
      onOpenChange={(expanded) => setOpen(expanded)}
    >
      {error ? (
        <div role="alert">
          {error}
          <Button onClick={() => setRetry((value) => value + 1)}>重试</Button>
        </div>
      ) : source === undefined ? (
        <p role="status">正在读取源码…</p>
      ) : source === null ? (
        <p>该用例没有附带 Java 源码。</p>
      ) : (
        <>
          <p className={cn("muted", uiPatterns["muted"])}>{source.reference.entryPath}</p>
          <pre
            className={cn("source-code-viewer", lazyCaseSourceStyles["source-code-viewer"])}
            tabIndex={0}
          >
            <code>{source.content}</code>
          </pre>
        </>
      )}
    </Disclosure>
  );
}

const lazyCaseSourceStyles = {
  "case-inspector-section":
    "min-w-0 overflow-hidden border border-solid border-border rounded-lg bg-card [&_.ui-disclosure-label]:min-h-11 [&_.ui-disclosure-label]:py-3 [&_.ui-disclosure-label]:px-3.5 [&_.ui-disclosure-label]:text-foreground [&_.ui-disclosure-label]:font-semibold [&_.ui-disclosure-label]:cursor-pointer [&[data-open=true]_.ui-disclosure-label]:border-b [&[data-open=true]_.ui-disclosure-label]:border-solid [&[data-open=true]_.ui-disclosure-label]:border-border [&_.ui-disclosure-body_>_:not(summary):not(.table-scroll)]:m-3.5 [&_.ui-disclosure-body_>_.settings-stack]:m-0 [&_.ui-disclosure-body_>_.settings-stack]:p-3.5",
  "source-code-viewer":
    "max-h-[640px] overflow-auto m-0 p-4.5 border border-solid border-border rounded-lg bg-log-background text-log-foreground font-mono text-xs leading-[1.65] [tab-size:2] whitespace-pre",
} as const;
