"use client";

import { Button, Input, Textarea } from "@/components/ui";

import { apiErrorSchema } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { LoaderCircle, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useToast } from "@/components/ui-feedback";

export function CaseDefinitionEditor({
  definition,
  onUpdated,
}: {
  definition: CaseDefinitionWithMethods;
  onUpdated?: (definition: CaseDefinitionWithMethods) => void;
}) {
  const router = useRouter();
  const toast = useToast();
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
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      const updated = (await response.json()) as CaseDefinitionWithMethods;
      toast.success("用例已更新。");
      onUpdated?.(updated);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新用例失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="settings-grid-form" onSubmit={(event) => void submit(event)}>
      <label>
        显示名称
        <Input name="displayName" required maxLength={200} defaultValue={definition.displayName} />
      </label>
      <label>
        标签（逗号分隔）
        <Input name="tags" maxLength={2000} defaultValue={definition.tags.join(", ")} />
      </label>
      <label className="settings-wide-field">
        描述
        <Textarea
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={definition.description}
        />
      </label>
      <label className="checkbox-field">
        <Input name="enabled" type="checkbox" defaultChecked={definition.enabled} />
        启用（禁用后新建批次不再执行该用例）
      </label>
      <label className="checkbox-field">
        <Input name="archived" type="checkbox" defaultChecked={definition.archived} />
        归档（保留历史记录，从日常列表中隐藏）
      </label>
      <div className="settings-form-actions">
        {error ? (
          <small className="form-error" role="alert">
            {error}
          </small>
        ) : null}
        <Button className="primary-button" disabled={pending} type="submit">
          {pending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} 保存修改
        </Button>
      </div>
    </form>
  );
}
