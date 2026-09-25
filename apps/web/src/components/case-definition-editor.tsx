"use client";
import { LoadingIcon } from "@/components/ui/loading-icon";

import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button, Input, Textarea } from "@/components/ui";

import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useToast } from "@/components/ui-feedback";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { throwApiErrorResponse } from "@/lib/client-api";

export function CaseDefinitionEditor({
  definition,
  onUpdated,
}: {
  definition: CaseDefinitionWithMethods;
  onUpdated?: (definition: CaseDefinitionWithMethods) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tags = String(form.get("tags") ?? "")
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/case-definitions/${encodeURIComponent(definition.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            displayName: form.get("displayName"),
            description: form.get("description"),
            tags,
            enabled: form.get("enabled") === "on",
            archived: form.get("archived") === "on",
            expectedRevision: definition.revision,
          }),
        },
      );
      if (!response.ok) {
        await throwApiErrorResponse(response, `请求失败（HTTP ${response.status}）。`);
      }
      const updated = (await response.json()) as CaseDefinitionWithMethods;
      toast.success("用例已更新。");
      onUpdated?.(updated);
      router.refresh();
    } catch (caught) {
      if (await showConcurrentModification(caught)) return;
      setError(caught instanceof Error ? caught.message : "更新用例失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={cn("settings-grid-form", uiPatterns["settings-grid-form"])}
      onSubmit={(event) => void submit(event)}
    >
      <label>
        显示名称
        <Input name="displayName" required maxLength={200} defaultValue={definition.displayName} />
      </label>
      <label>
        标签（逗号分隔）
        <Input name="tags" maxLength={2000} defaultValue={definition.tags.join(", ")} />
      </label>
      <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
        描述
        <Textarea
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={definition.description}
        />
      </label>
      <label className={cn("checkbox-field", uiPatterns["checkbox-field"])}>
        <Input name="enabled" type="checkbox" defaultChecked={definition.enabled} />
        启用（禁用后新建批次不再执行该用例）
      </label>
      <label className={cn("checkbox-field", uiPatterns["checkbox-field"])}>
        <Input name="archived" type="checkbox" defaultChecked={definition.archived} />
        归档（保留历史记录，从日常列表中隐藏）
      </label>
      <div
        className={cn("settings-form-actions", caseDefinitionEditorStyles["settings-form-actions"])}
      >
        {error ? (
          <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])} role="alert">
            {error}
          </Notice>
        ) : null}
        <Button
          className={cn("primary-button", uiPatterns["primary-button"])}
          disabled={pending}
          type="submit"
        >
          {pending ? <LoadingIcon size={15} /> : <Save size={15} />} 保存修改
        </Button>
      </div>
    </form>
  );
}

const caseDefinitionEditorStyles = {
  "settings-form-actions":
    "flex justify-end gap-2.5 [&.management-sticky-actions]:bottom-3 [&.management-sticky-actions]:border [&.management-sticky-actions]:border-solid [&.management-sticky-actions]:border-border [&.management-sticky-actions]:rounded-xl [&.management-sticky-actions]:shadow-xs",
} as const;
