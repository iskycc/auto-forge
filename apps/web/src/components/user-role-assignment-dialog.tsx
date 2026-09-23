"use client";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { Project, Role, User } from "@autoforge/domain";
import { useState, type FormEvent } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { UserPicker } from "./user-picker";
import { useConfirm } from "./ui-feedback";
import { Button, CheckboxGroup, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

export function UserRoleAssignmentDialog({
  selectedUser,
  assignedRoles = [],
  roles,
  projects,
  canAssignSystemRoles,
  onClose,
  onAssigned,
}: {
  selectedUser: User | null;
  assignedRoles?: Array<{ roleId: string; projectId?: string }>;
  roles: Role[];
  projects: Project[];
  canAssignSystemRoles: boolean;
  onClose(): void;
  onAssigned(message: string): void;
}) {
  const confirmAction = useConfirm();
  const [pending, setPending] = useState(false);
  const [bindings, setBindings] = useState(assignedRoles);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [error, setError] = useState("");
  const systemRoles = roles.filter((role) => role.scope === "system" && role.active);
  const projectRoles = roles.filter((role) => role.scope === "project" && role.active);

  async function submit(event: FormEvent<HTMLFormElement>, scope: "system" | "project") {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const userIds = selectedUser
      ? [selectedUser.id]
      : [...new Set(form.getAll("userId").map(String).filter(Boolean))];
    const roleIds = form.getAll("roleId").map(String);
    const projectId = String(form.get("projectId") ?? "");
    if (!userIds.length || !roleIds.length || (scope === "project" && !projectId)) {
      setError(scope === "system" ? "请选择用户和系统角色。" : "请选择用户、项目和项目角色。");
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/v1/role-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds,
          roleIds,
          ...(scope === "project" ? { projectId } : {}),
        }),
      });
      const message = await readApiErrorMessage(response, "角色分配失败。");
      if (message) {
        setError(message);
        return;
      }
      onAssigned(
        `已分配 ${roleIds.length} 个${scope === "system" ? "系统" : "项目"}角色，旧会话已撤销。`,
      );
    } catch {
      setError("角色分配请求未完成，请检查网络连接后重试。");
    } finally {
      setPending(false);
    }
  }

  async function removeBinding(binding: { roleId: string; projectId?: string }) {
    if (
      !selectedUser ||
      !(await confirmAction({
        title: "撤销用户角色",
        description: "撤销后该用户的旧会话立即失效，需要重新登录。",
        confirmLabel: "确认撤销",
        tone: "danger",
      }))
    )
      return;
    setPending(true);
    setError("");
    try {
      const suffix = binding.projectId
        ? `project-roles/${encodeURIComponent(binding.projectId)}/${encodeURIComponent(binding.roleId)}`
        : `system-roles/${encodeURIComponent(binding.roleId)}`;
      const response = await fetch(
        `/api/v1/users/${encodeURIComponent(selectedUser.id)}/${suffix}`,
        { method: "DELETE" },
      );
      const message = await readApiErrorMessage(response, "撤销角色失败。");
      if (message) throw new Error(message);
      setBindings((current) => current.filter((item) => item !== binding));
      onAssigned("角色已撤销，旧会话已失效。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <ActionDialog
      protectUnsavedChanges
      className={cn(
        "role-assignment-dialog",
        userRoleAssignmentDialogStyles["role-assignment-dialog"],
      )}
      description="系统角色对全局生效，项目角色仅对选定项目生效。分配后会撤销目标用户的旧会话，需重新登录。"
      onClose={() => {
        if (!pending) onClose();
      }}
      open
      title="分配用户角色"
    >
      <div
        className={cn(
          "user-role-assignment-content",
          userRoleAssignmentDialogStyles["user-role-assignment-content"],
        )}
      >
        {selectedUser ? (
          <div
            className={cn(
              "member-role-subject user-role-assignment-subject",
              userRoleAssignmentDialogStyles["member-role-subject"],
              userRoleAssignmentDialogStyles["user-role-assignment-subject"],
            )}
          >
            <strong>{selectedUser.displayName}</strong>
            <span>{selectedUser.username}</span>
          </div>
        ) : null}
        {selectedUser ? (
          <section
            className={cn(
              "assigned-role-list",
              userRoleAssignmentDialogStyles["assigned-role-list"],
            )}
          >
            <h3>当前已分配角色</h3>
            {bindings.length ? (
              bindings.map((binding) => (
                <div key={`${binding.projectId ?? "system"}:${binding.roleId}`}>
                  <span>
                    {binding.projectId
                      ? (projects.find((project) => project.id === binding.projectId)?.name ??
                        "其他项目")
                      : "系统范围"}{" "}
                    · {roles.find((role) => role.id === binding.roleId)?.name ?? binding.roleId}
                  </span>
                  {(
                    binding.projectId
                      ? projects.some((project) => project.id === binding.projectId)
                      : canAssignSystemRoles
                  ) ? (
                    <Button
                      disabled={pending}
                      onClick={() => void removeBinding(binding)}
                      size="compact"
                      type="button"
                      variant="danger"
                    >
                      撤销
                    </Button>
                  ) : null}
                </div>
              ))
            ) : (
              <p className={cn("settings-note", uiPatterns["settings-note"])}>尚未分配角色。</p>
            )}
          </section>
        ) : null}
        <div
          className={cn(
            "settings-paired-forms",
            userRoleAssignmentDialogStyles["settings-paired-forms"],
          )}
        >
          {canAssignSystemRoles ? (
            <form
              className={cn(
                "settings-grid-form settings-subform",
                uiPatterns["settings-grid-form"],
                uiPatterns["settings-subform"],
              )}
              onSubmit={(event) => void submit(event, "system")}
            >
              {!selectedUser ? <UserPicker purpose="system-role" multiple /> : null}
              <CheckboxGroup
                label="系统角色"
                name="roleId"
                required
                options={systemRoles
                  .filter(
                    (role) =>
                      !bindings.some((binding) => binding.roleId === role.id && !binding.projectId),
                  )
                  .map((role) => ({
                    value: role.id,
                    label: role.name,
                    description: role.description,
                  }))}
              />
              {systemRoles.length === 0 ? (
                <p
                  className={cn(
                    "settings-wide-field field-hint",
                    uiPatterns["settings-wide-field"],
                    uiPatterns["field-hint"],
                  )}
                >
                  暂无可分配的系统角色。
                </p>
              ) : null}
              <Button disabled={pending || systemRoles.length === 0} type="submit">
                分配系统角色
              </Button>
            </form>
          ) : null}
          {projects.length > 0 ? (
            <form
              className={cn(
                "settings-grid-form settings-subform",
                uiPatterns["settings-grid-form"],
                uiPatterns["settings-subform"],
              )}
              onSubmit={(event) => void submit(event, "project")}
            >
              {!selectedUser ? (
                <UserPicker
                  key={projectId}
                  purpose="project-member"
                  projectId={projectId}
                  multiple
                />
              ) : null}
              <div
                className={cn("user-role-field", userRoleAssignmentDialogStyles["user-role-field"])}
              >
                <label htmlFor="role-assignment-project">项目</label>
                <Select
                  disabled={pending}
                  id="role-assignment-project"
                  name="projectId"
                  required
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </div>
              <CheckboxGroup
                key={projectId}
                label="项目角色"
                name="roleId"
                required
                options={projectRoles
                  .filter(
                    (role) =>
                      !bindings.some(
                        (binding) => binding.roleId === role.id && binding.projectId === projectId,
                      ),
                  )
                  .map((role) => ({
                    value: role.id,
                    label: role.name,
                    description: role.description,
                  }))}
              />
              {projectRoles.length === 0 ? (
                <p
                  className={cn(
                    "settings-wide-field field-hint",
                    uiPatterns["settings-wide-field"],
                    uiPatterns["field-hint"],
                  )}
                >
                  暂无可分配的项目角色。
                </p>
              ) : null}
              <Button disabled={pending || projectRoles.length === 0} type="submit">
                分配项目角色
              </Button>
            </form>
          ) : (
            <p className={cn("field-hint", uiPatterns["field-hint"])}>
              没有可分配角色的未归档项目。
            </p>
          )}
        </div>
        {error ? (
          <Notice tone="error" className={cn("auth-error", uiPatterns["auth-error"])} role="alert">
            {error}
          </Notice>
        ) : null}
        <div
          className={cn(
            "action-dialog-actions",
            userRoleAssignmentDialogStyles["action-dialog-actions"],
          )}
        >
          <Button data-dialog-dismiss disabled={pending} onClick={onClose} type="button">
            取消
          </Button>
        </div>
      </div>
    </ActionDialog>
  );
}

const userRoleAssignmentDialogStyles = {
  "action-dialog-actions": "flex justify-end gap-[9px] border-t border-solid border-border pt-4",
  "assigned-role-list":
    "grid gap-2 [&_>_div]:flex [&_>_div]:justify-between [&_>_div]:items-center [&_>_div]:gap-3 [&_>_div]:[overflow-wrap:anywhere]",
  "member-role-subject":
    "grid gap-[3px] rounded-lg py-3 px-3.5 bg-muted [&_span]:text-muted-foreground [&_span]:text-xs [&_span]:[overflow-wrap:anywhere]",
  "role-assignment-dialog":
    "[&_.settings-paired-forms]:grid-cols-[minmax(0,_1fr)] w-[min(700px,_calc(100dvw_-_40px))] [&_.settings-subform]:grid-cols-[minmax(0,_1fr)] [&_.settings-subform]:pt-4 [&_.settings-subform_>_.ui-button]:self-end",
  "settings-paired-forms":
    "grid grid-cols-2 gap-4 [&_>_*]:min-w-0 [&_.settings-subform]:mt-0 [&_.settings-subform]:pt-0 [&_.settings-subform]:border-t-0",
  "user-role-assignment-content": "grid min-w-0 gap-4",
  "user-role-assignment-subject": "min-w-0 [overflow-wrap:anywhere]",
  "user-role-field": "grid [align-content:start] min-w-0 gap-2",
} as const;
