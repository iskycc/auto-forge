"use client";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { readApiErrorMessage } from "@/lib/client-api";
import { ActionDialog } from "./action-dialog";
import { Button, Input } from "./ui";
import { useToast } from "./ui-feedback";
import { VersionInitializationDialog } from "./version-initialization-dialog";

export type ProjectContext = {
  projectId: string;
  projectVersionId?: string;
  testStageId?: string;
};

export type HierarchyCreationTarget =
  | { kind: "project" }
  | { kind: "version"; projectId: string; projectName: string }
  | {
      kind: "stage";
      projectId: string;
      projectName: string;
      projectVersionId: string;
      projectVersionName: string;
    };

export function CreateProjectHierarchyDialog({
  target,
  onCreated,
  onClose,
}: {
  target: HierarchyCreationTarget;
  onCreated(context: ProjectContext): Promise<void>;
  onClose(): void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [createdContext, setCreatedContext] = useState<ProjectContext | null>(null);
  const [createdVersionName, setCreatedVersionName] = useState("");
  const label =
    target.kind === "project" ? "项目" : target.kind === "version" ? "项目版本" : "测试阶段";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    let context = createdContext;
    try {
      if (!context) {
        const path =
          target.kind === "project"
            ? "/api/v1/projects"
            : target.kind === "version"
              ? `/api/v1/projects/${target.projectId}/versions`
              : `/api/v1/projects/${target.projectId}/versions/${target.projectVersionId}/stages`;
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.get("name"),
            ...(target.kind === "project" ? { slug: form.get("slug") } : {}),
            ...(target.kind === "stage" ? { description: form.get("description") } : {}),
          }),
        });
        const message = await readApiErrorMessage(response, `新建${label}失败。`);
        if (message) throw new Error(message);
        const created = (await response.json()) as { id: string };
        context =
          target.kind === "project"
            ? { projectId: created.id }
            : target.kind === "version"
              ? { projectId: target.projectId, projectVersionId: created.id }
              : {
                  projectId: target.projectId,
                  projectVersionId: target.projectVersionId,
                  testStageId: created.id,
                };
        // Creation and selection are separate requests. A selection retry must not create duplicates.
        setCreatedContext(context);
        if (target.kind === "version") {
          setCreatedVersionName(String(form.get("name") ?? ""));
          toast.success("项目版本已创建，可以按需初始化或跳过全部步骤。");
          return;
        }
      }
      await onCreated(context);
      toast.success(`${label}已创建并切换。`);
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "请求未完成，请检查网络后重试。";
      setError(
        context
          ? `${label}已创建，但切换失败：${message} 点击下方按钮重试切换，不会重复创建。`
          : message,
      );
    } finally {
      setPending(false);
    }
  }

  if (target.kind === "version" && createdContext?.projectVersionId)
    return (
      <VersionInitializationDialog
        projectId={target.projectId}
        projectName={target.projectName}
        versionId={createdContext.projectVersionId}
        versionName={createdVersionName}
        onFinish={onCreated}
        onClose={() => {
          onClose();
          router.refresh();
        }}
      />
    );

  return (
    <ActionDialog
      open
      protectUnsavedChanges={!createdContext}
      title={`新建${label}`}
      description={
        target.kind === "project"
          ? "创建后由你担任项目负责人，并自动切换到新项目。"
          : target.kind === "version"
            ? `所属项目：${target.projectName}。创建后可按需初始化，所有初始化步骤均可跳过；支持从其他版本继承。`
            : `所属项目：${target.projectName} · 所属版本：${target.projectVersionName}`
      }
      onClose={() => {
        if (pending) return;
        onClose();
        if (createdContext) router.refresh();
      }}
    >
      <form
        className={cn(
          "settings-grid-form action-dialog-form",
          uiPatterns["settings-grid-form"],
          createProjectHierarchyDialogStyles["action-dialog-form"],
        )}
        onSubmit={submit}
      >
        {error ? (
          <Notice
            tone="error"
            className={cn(
              "form-error settings-wide-field",
              uiPatterns["form-error"],
              uiPatterns["settings-wide-field"],
            )}
            role="alert"
          >
            {error}
          </Notice>
        ) : null}
        <label
          className={
            target.kind === "version"
              ? cn("settings-wide-field", uiPatterns["settings-wide-field"])
              : undefined
          }
        >
          {target.kind === "project"
            ? "项目名称"
            : target.kind === "version"
              ? "版本名称"
              : "阶段名称"}
          <Input
            name="name"
            required
            maxLength={target.kind === "project" ? 120 : 128}
            disabled={pending || Boolean(createdContext)}
          />
        </label>
        {target.kind === "project" ? (
          <label>
            Slug
            <Input
              name="slug"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              required
              minLength={2}
              maxLength={64}
              disabled={pending || Boolean(createdContext)}
            />
          </label>
        ) : null}
        {target.kind === "stage" ? (
          <label>
            阶段说明
            <Input
              name="description"
              maxLength={2000}
              disabled={pending || Boolean(createdContext)}
            />
          </label>
        ) : null}
        <div
          className={cn(
            "settings-form-actions",
            createProjectHierarchyDialogStyles["settings-form-actions"],
          )}
        >
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "正在保存…" : createdContext ? `切换到新建${label}` : `新建${label}`}
          </Button>
        </div>
      </form>
    </ActionDialog>
  );
}

const createProjectHierarchyDialogStyles = {
  "action-dialog-form": "mt-0",
  "settings-form-actions":
    "flex justify-end gap-2.5 [&.management-sticky-actions]:bottom-3 [&.management-sticky-actions]:border [&.management-sticky-actions]:border-solid [&.management-sticky-actions]:border-border [&.management-sticky-actions]:rounded-xl [&.management-sticky-actions]:shadow-xs",
} as const;
