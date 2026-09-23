"use client";
import { Notice } from "@/components/ui/notice";

import { LinkButton } from "@/components/ui/link-button";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { Project } from "@autoforge/domain";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ActionDialog } from "./action-dialog";
import { Button } from "./ui";
import { UserPicker } from "./user-picker";
import { useConfirm, useToast } from "./ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";

export function ProjectActions({ project, canManage }: { project?: Project; canManage: boolean }) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [actionDialog, setActionDialog] = useState<"owner" | null>(null);
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
            转移负责
          </Button>
        ) : null}
      </div>
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
