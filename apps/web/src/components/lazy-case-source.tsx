"use client";

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
    <details
      className="case-inspector-section"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>用例源码</summary>
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
          <p className="muted">{source.reference.entryPath}</p>
          <pre className="source-code-viewer" tabIndex={0}>
            <code>{source.content}</code>
          </pre>
        </>
      )}
    </details>
  );
}
