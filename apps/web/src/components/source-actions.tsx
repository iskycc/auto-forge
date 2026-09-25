"use client";
import { Notice } from "@/components/ui/notice";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SourceActions({
  sourceId,
  authoritative,
}: {
  sourceId: string;
  authoritative: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function makeAuthoritative(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/case-sources/${encodeURIComponent(sourceId)}/authoritative`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ authoritative: true }),
        },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "设置全量来源失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={cn("inline-action-stack", sourceActionsStyles["inline-action-stack"])}>
      <Button
        className={cn(
          uiPatterns["button"],
          `button ${authoritative ? cn("button-success", uiPatterns["button-success"]) : cn("button-secondary", uiPatterns["button-secondary"])}`,
        )}
        type="button"
        disabled={authoritative || pending}
        onClick={makeAuthoritative}
      >
        {pending ? <LoadingIcon size={15} /> : <Check size={15} />}
        {authoritative ? "当前全量来源" : "设为全量来源"}
      </Button>
      {error && (
        <Notice tone="error" className={cn("inline-error", sourceActionsStyles["inline-error"])}>
          {error}
        </Notice>
      )}
    </span>
  );
}

const sourceActionsStyles = {
  "inline-action-stack":
    "inline-flex items-center gap-2 flex-wrap [&_.inline-error]:[flex-basis:100%]",
  "inline-error": "text-destructive text-xs leading-[1.35]",
} as const;
