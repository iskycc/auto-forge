"use client";

import { startFailureAnalysisBatchResultSchema } from "@autoforge/contracts";
import { LoaderCircle, SearchCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";
import { useToast } from "@/components/ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";

export type FailureAnalysisScope = { projectId: string; projectVersionId: string; batchId: string };

export function StartFailureAnalysisButton({
  scope,
  onStarted,
}: {
  scope: FailureAnalysisScope;
  onStarted?: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState(false);

  async function start() {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch("/api/v1/failure-analysis/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope),
      });
      const error = await readApiErrorMessage(response, "开始分析失败，请稍后重试。");
      if (error) throw new Error(error);
      const result = startFailureAnalysisBatchResultSchema.parse(await response.json());
      setStarted(true);
      if (result.created) toast.success("已开始分析，可在用例分析页面查看和分配失败用例。");
      else toast.info("该执行已开始分析，可直接进入已有分析任务。");
      onStarted?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "开始分析失败。");
    } finally {
      setPending(false);
    }
  }

  if (started)
    return (
      <Link
        className="button button-secondary compact-button"
        href={`/case-analysis/${encodeURIComponent(scope.batchId)}`}
      >
        <SearchCheck size={14} /> 查看分析
      </Link>
    );
  return (
    <Button
      className="button button-secondary compact-button"
      disabled={pending}
      onClick={() => void start()}
      type="button"
    >
      {pending ? <LoaderCircle className="spin" size={14} /> : <SearchCheck size={14} />}开始分析
    </Button>
  );
}
