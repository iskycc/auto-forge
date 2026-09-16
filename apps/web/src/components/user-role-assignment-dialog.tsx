"use client";

import type { Project, Role, User } from "@autoforge/domain";
import { useState, type FormEvent } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { Button, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

export function UserRoleAssignmentDialog({
  users,
  selectedUser,
  roles,
  projects,
  canAssignSystemRoles,
  onClose,
  onAssigned,
}: {
  users: User[];
  selectedUser: User | null;
  roles: Role[];
  projects: Project[];
  canAssignSystemRoles: boolean;
  onClose(): void;
  onAssigned(message: string): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const systemRoles = roles.filter((role) => role.scope === "system" && role.active);
  const projectRoles = roles.filter((role) => role.scope === "project" && role.active);
  const hasUsers = selectedUser !== null || users.length > 0;

  async function submit(event: FormEvent<HTMLFormElement>, scope: "system" | "project") {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const userId = selectedUser?.id ?? String(form.get("userId") ?? "");
    const roleId = String(form.get("roleId") ?? "");
    const projectId = String(form.get("projectId") ?? "");
    if (!userId || !roleId || (scope === "project" && !projectId)) {
      setError(scope === "system" ? "请选择用户和系统角色。" : "请选择用户、项目和项目角色。");
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/users/${encodeURIComponent(userId)}/${scope}-roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope === "system" ? { roleId } : { projectId, roleId }),
      });
      const message = await readApiErrorMessage(response, "角色分配失败，请稍后重试。");
      if (message) {
        setError(message);
        return;
      }
      onAssigned(scope === "system" ? "系统角色已分配，旧会话已撤销。" : "项目成员角色已分配。");
    } catch {
      setError("角色分配请求未完成，请检查网络连接后重试。");
    } finally {
      setPending(false);
    }
  }

  function userSelection(scope: "system" | "project") {
    if (selectedUser) return null;
    const id = `role-assignment-${scope}-user`;
    return (
      <div className="user-role-field">
        <label htmlFor={id}>用户</label>
        <Select disabled={pending || !hasUsers} id={id} name="userId" required>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName} · {user.username}
            </option>
          ))}
        </Select>
      </div>
    );
  }

  return (
    <ActionDialog
      className="role-assignment-dialog"
      description="系统角色对全局生效，项目角色仅对选定项目生效。分配后会撤销目标用户的旧会话，需重新登录。"
      onClose={() => {
        if (!pending) onClose();
      }}
      open
      title="分配用户角色"
    >
      <div className="user-role-assignment-content">
        {selectedUser ? (
          <div className="member-role-subject user-role-assignment-subject">
            <strong>{selectedUser.displayName}</strong>
            <span>
              {selectedUser.username} · {selectedUser.id}
            </span>
          </div>
        ) : null}
        {!hasUsers ? (
          <p className="empty-state">当前列表没有用户，请先创建用户或调整搜索条件。</p>
        ) : null}
        <div className="settings-paired-forms">
          {canAssignSystemRoles ? (
            <form
              className="settings-grid-form settings-subform"
              onSubmit={(event) => void submit(event, "system")}
            >
              {userSelection("system")}
              <div className="user-role-field">
                <label htmlFor="role-assignment-system-role">系统角色</label>
                <Select
                  disabled={pending || systemRoles.length === 0}
                  id="role-assignment-system-role"
                  name="roleId"
                  required
                >
                  {systemRoles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              </div>
              {systemRoles.length === 0 ? (
                <p className="settings-wide-field field-hint">暂无可分配的系统角色。</p>
              ) : null}
              <Button disabled={pending || !hasUsers || systemRoles.length === 0} type="submit">
                分配系统角色
              </Button>
            </form>
          ) : null}
          {projects.length > 0 ? (
            <form
              className="settings-grid-form settings-subform"
              onSubmit={(event) => void submit(event, "project")}
            >
              {userSelection("project")}
              <div className="user-role-field">
                <label htmlFor="role-assignment-project">项目</label>
                <Select disabled={pending} id="role-assignment-project" name="projectId" required>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="user-role-field">
                <label htmlFor="role-assignment-project-role">项目角色</label>
                <Select
                  disabled={pending || projectRoles.length === 0}
                  id="role-assignment-project-role"
                  name="roleId"
                  required
                >
                  {projectRoles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </Select>
              </div>
              {projectRoles.length === 0 ? (
                <p className="settings-wide-field field-hint">暂无可分配的项目角色。</p>
              ) : null}
              <Button disabled={pending || !hasUsers || projectRoles.length === 0} type="submit">
                分配项目角色
              </Button>
            </form>
          ) : (
            <p className="field-hint">没有可分配角色的未归档项目。</p>
          )}
        </div>
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="action-dialog-actions">
          <Button disabled={pending} onClick={onClose} type="button">
            取消
          </Button>
        </div>
      </div>
    </ActionDialog>
  );
}
