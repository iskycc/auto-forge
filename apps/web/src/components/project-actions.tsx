"use client";
import { Notice } from "@/components/ui/notice";

import { LinkButton } from "@/components/ui/link-button";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { Project } from "@autoforge/domain";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ActionDialog } from "./action-dialog";
import { Button, Input } from "./ui";
import { UserPicker } from "./user-picker";
import { useConfirm, useToast } from "./ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";

export function ProjectActions({ project, canManage }: { project?: Project; canManage: boolean }) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [actionDialog, setActionDialog] = useState<"owner" | "rename" | null>(null);
  const [projectName, setProjectName] = useState(project?.name ?? "");
  async function request(path: string, init: RequestInit, success: string): Promise<void> {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(path, init);
      const errorMessage = await readApiErrorMessage(response, "操作失败。");
      if (errorMessage) throw new Error(errorMessage);
      toast.success(success);
      setActionDialog(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setPending(false);
    }
  }

  async function transferOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    const form = new FormData(event.currentTarget);
    const ownerUserId = String(form.get("ownerUserId") ?? "");
    if (!ownerUserId) {
      setError("请选择新负责人。");
      return;
    }
    if (
      !(await confirmAction({
        title: "转移项目负责人",
        description: "新负责人会自动获得项目管理能力，当前负责人将不再拥有负责人身份。",
        confirmLabel: "确认转移",
        tone: "danger",
      }))
    )
      return;
    void request(
      `/api/v1/projects/${project.id}/owner`,
      jsonRequest("POST", { ownerUserId }),
      "项目负责人已转移。",
    );
  }

  return (
    <div
      className={cn(
        "project-administration-bar",
        projectActionsStyles["project-administration-bar"],
      )}
    >
      <div
        className={cn(
          "project-administration-summary",
          projectActionsStyles["project-administration-summary"],
        )}
      >
        <strong title={project?.name}>{project?.name ?? "暂无项目"}</strong>
        <span>
          {project
            ? `${project.slug} · ${project.archived ? "已归档" : "启用"}`
            : "请从顶栏新建项目"}
        </span>
      </div>
      <div className={cn("button-row", uiPatterns["button-row"])}>
        {canManage && project && !project.archived ? (
          <Button
            type="button"
            onClick={() => {
              setError("");
              setProjectName(project.name);
              setActionDialog("rename");
            }}
          >
            修改项目名称
          </Button>
        ) : null}
        {project ? (
          <LinkButton className={"ui-button"} href="/settings/access?section=users&scope=project">
            管理成员
          </LinkButton>
        ) : null}
        {canManage && project && !project.archived ? (
          <Button
            onClick={() => {
              setError("");
              setActionDialog("owner");
            }}
            type="button"
          >
            转移负责人
          </Button>
        ) : null}
      </div>
      {project ? (
        <ActionDialog
          open={actionDialog === "rename"}
          title="修改项目名称"
          description="默认项目也可以改名。项目标识、版本、用例、任务和历史执行关联保持不变。"
          onClose={() => !pending && setActionDialog(null)}
          protectUnsavedChanges
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void request(
                `/api/v1/projects/${project.id}`,
                jsonRequest("PATCH", { name: projectName.trim() }),
                "项目名称已更新。",
              );
            }}
          >
            {error ? (
              <Notice tone="error" role="alert">
                {error}
              </Notice>
            ) : null}
            <label className="grid gap-2">
              项目名称
              <Input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                maxLength={120}
                required
                autoFocus
                disabled={pending}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" disabled={pending} onClick={() => setActionDialog(null)}>
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={pending || !projectName.trim() || projectName.trim() === project.name}
              >
                {pending ? "正在保存…" : "保存名称"}
              </Button>
            </div>
          </form>
        </ActionDialog>
      ) : null}
      {project ? (
        <ActionDialog
          protectUnsavedChanges
          description="新负责人会自动获得项目管理能力。"
          onClose={() => !pending && setActionDialog(null)}
          open={actionDialog === "owner"}
          title="转移项目负责人"
        >
          <form
            className={cn(
              "settings-grid-form action-dialog-form",
              uiPatterns["settings-grid-form"],
              projectActionsStyles["action-dialog-form"],
            )}
            onSubmit={transferOwner}
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
            <UserPicker name="ownerUserId" purpose="project-owner" projectId={project.id} />
            <Button
              className={cn("secondary-button", uiPatterns["secondary-button"])}
              disabled={pending}
              type="submit"
            >
              转移负责人
            </Button>
          </form>
        </ActionDialog>
      ) : null}
    </div>
  );
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const projectActionsStyles = {
  "action-dialog-form": "mt-0",
  "project-administration-bar": "flex items-center justify-between gap-3 min-w-0 flex-wrap",
  "project-administration-summary":
    "flex min-w-0 flex-1 items-baseline gap-3 [&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_>_span]:shrink-0 [&_>_span]:text-muted-foreground [&_>_span]:text-xs",
} as const;
