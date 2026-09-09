"use client";

import type { Project, Role, User } from "@autoforge/domain";
import { ShieldCheck, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button, Input, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { ActionDialog } from "@/components/action-dialog";
import { useConfirm, useToast } from "@/components/ui-feedback";

type ProjectMember = { user: User; roleIds: string[] };

export function ProjectMembershipManager({
  project,
  members,
  roles,
  canManage,
  canCreateProject,
}: {
  project: Project;
  members: ProjectMember[];
  roles: Role[];
  canManage: boolean;
  canCreateProject: boolean;
}) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [actionDialog, setActionDialog] = useState<"project" | "member" | "owner" | null>(null);
  const [roleDialogMember, setRoleDialogMember] = useState<ProjectMember | null>(null);
  const [roleDialogError, setRoleDialogError] = useState("");

  async function request(path: string, init: RequestInit, success: string) {
    setPending(true);
    setError("");
    try {
      const response = await fetch(path, init);
      const errorMessage = await readApiErrorMessage(response, "操作失败。");
      if (errorMessage) throw new Error(errorMessage);
      toast.success(success);
      setActionDialog(null);
      router.refresh();
      setPending(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
      setPending(false);
    }
  }

  function addMemberRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const userId = String(form.get("userId") ?? "").trim();
    void request(
      `/api/v1/users/${encodeURIComponent(userId)}/project-roles`,
      jsonRequest("POST", { projectId: project.id, roleId: form.get("roleId") }),
      "项目角色已分配，目标用户的旧会话已撤销。",
    );
  }

  function openMemberRoleDialog(member: ProjectMember): void {
    setRoleDialogError("");
    setRoleDialogMember({ user: member.user, roleIds: [...member.roleIds] });
  }

  async function addRoleToMember(roleId: string): Promise<void> {
    const member = roleDialogMember;
    if (!member || member.roleIds.includes(roleId)) return;
    await updateMemberRole(member, roleId, "assign", "项目角色已添加，目标用户的旧会话已撤销。");
  }

  async function removeRoleFromMember(roleId: string): Promise<void> {
    const member = roleDialogMember;
    if (!member || !member.roleIds.includes(roleId)) return;
    const accepted = await confirmAction({
      title: "移除项目角色",
      description: `从“${member.user.displayName}”移除“${roleName(roles, roleId)}”后，会立即撤销该用户的旧会话。`,
      confirmLabel: "确认移除",
      tone: "danger",
    });
    if (!accepted) return;
    await updateMemberRole(
      member,
      roleId,
      "remove",
      member.roleIds.length === 1
        ? "最后一个项目角色已移除，该用户已不再是项目成员。"
        : "项目角色已移除，目标用户的旧会话已撤销。",
    );
  }

  async function updateMemberRole(
    member: ProjectMember,
    roleId: string,
    operation: "assign" | "remove",
    success: string,
  ): Promise<void> {
    const assigning = operation === "assign";
    const path = assigning
      ? `/api/v1/users/${encodeURIComponent(member.user.id)}/project-roles`
      : `/api/v1/users/${encodeURIComponent(member.user.id)}/project-roles/${encodeURIComponent(project.id)}/${encodeURIComponent(roleId)}`;
    const init = assigning
      ? jsonRequest("POST", { projectId: project.id, roleId })
      : { method: "DELETE" };
    setPending(true);
    setRoleDialogError("");
    try {
      const response = await fetch(path, init);
      const errorMessage = await readApiErrorMessage(response, "项目角色修改失败。");
      if (errorMessage) throw new Error(errorMessage);
      const nextRoleIds = assigning
        ? [...member.roleIds, roleId]
        : member.roleIds.filter((currentRoleId) => currentRoleId !== roleId);
      setRoleDialogMember(
        nextRoleIds.length > 0 ? { user: member.user, roleIds: nextRoleIds } : null,
      );
      toast.success(success);
      router.refresh();
    } catch (cause) {
      setRoleDialogError(cause instanceof Error ? cause.message : "项目角色修改失败。");
    } finally {
      setPending(false);
    }
  }

  function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      "/api/v1/projects",
      jsonRequest("POST", { name: form.get("name"), slug: form.get("slug") }),
      "项目已创建，可从顶栏切换到新项目。",
    );
  }

  async function transferOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ownerUserId = String(form.get("ownerUserId") ?? "");
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
    <div className="settings-stack">
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="content-card settings-section project-scope-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Project scope</p>
            <h2>{project.name}</h2>
            <p>
              {project.slug} · {project.archived ? "已归档" : "启用"} · 项目 ID {project.id}
            </p>
          </div>
          <div className="button-row">
            {canCreateProject ? (
              <Button onClick={() => setActionDialog("project")} type="button" variant="primary">
                创建项目
              </Button>
            ) : null}
            {canManage && !project.archived ? (
              <>
                <Button onClick={() => setActionDialog("member")} type="button">
                  <UserPlus size={16} /> 添加成员
                </Button>
                <Button onClick={() => setActionDialog("owner")} type="button">
                  转移负责
                </Button>
              </>
            ) : null}
            {!canCreateProject && !canManage ? <ShieldCheck size={22} aria-hidden="true" /> : null}
          </div>
        </div>
        <ActionDialog
          description="新项目创建后会自动由当前用户担任负责人。"
          onClose={() => !pending && setActionDialog(null)}
          open={actionDialog === "project"}
          title="创建项目"
        >
          <form className="settings-grid-form action-dialog-form" onSubmit={createProject}>
            <label>
              项目名称
              <Input name="name" required />
            </label>
            <label>
              Slug
              <Input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
            </label>
            <Button disabled={pending} type="submit" variant="primary">
              创建项目
            </Button>
          </form>
        </ActionDialog>
        <ActionDialog
          description="为用户分配当前项目中的一个项目角色。"
          onClose={() => !pending && setActionDialog(null)}
          open={actionDialog === "member"}
          title="添加项目成员"
        >
          <form className="settings-grid-form action-dialog-form" onSubmit={addMemberRole}>
            <label>
              用户 ID
              <Input name="userId" placeholder="用户详情中显示的 UUID" required />
            </label>
            <label>
              项目角色
              <Select name="roleId" required>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              className="primary-button"
              disabled={pending || roles.length === 0}
              type="submit"
            >
              <UserPlus size={16} /> 添加成员角色
            </Button>
          </form>
        </ActionDialog>
        <ActionDialog
          description="新负责人会自动获得项目管理能力。"
          onClose={() => !pending && setActionDialog(null)}
          open={actionDialog === "owner"}
          title="转移项目负责人"
        >
          <form className="settings-grid-form action-dialog-form" onSubmit={transferOwner}>
            <label>
              新负责人
              <Select defaultValue={project.ownerUserId ?? ""} name="ownerUserId" required>
                <option disabled value="">
                  选择启用成员
                </option>
                {members
                  .filter((member) => member.user.status === "active")
                  .map((member) => (
                    <option key={member.user.id} value={member.user.id}>
                      {member.user.displayName} · {member.user.username}
                    </option>
                  ))}
              </Select>
            </label>
            <Button className="secondary-button" disabled={pending} type="submit">
              转移负责人
            </Button>
          </form>
        </ActionDialog>
        <ActionDialog
          className="member-role-dialog"
          description={`直接添加或移除“${project.name}”内的项目角色；每次变更立即生效并撤销目标用户的旧会话。`}
          onClose={() => !pending && setRoleDialogMember(null)}
          open={roleDialogMember !== null}
          title={
            roleDialogMember
              ? `管理“${roleDialogMember.user.displayName}”的项目角色`
              : "管理项目角色"
          }
        >
          {roleDialogMember ? (
            <div className="member-role-dialog-content">
              <div className="member-role-subject">
                <strong>{roleDialogMember.user.displayName}</strong>
                <span>
                  {roleDialogMember.user.username} · {roleDialogMember.user.id}
                </span>
              </div>
              {roleDialogError ? (
                <p className="auth-error" role="alert">
                  {roleDialogError}
                </p>
              ) : null}
              <div className="role-grid member-role-grid">
                {manageableProjectRoles(roles, roleDialogMember.roleIds).map((role) => {
                  const assigned = roleDialogMember.roleIds.includes(role.id);
                  return (
                    <article className="role-card member-role-card" key={role.id}>
                      <div>
                        <strong>{role.name}</strong>
                        <span
                          className={`status-badge ${assigned ? "status-ready" : "status-muted"}`}
                        >
                          {assigned ? "已分配" : "未分配"}
                        </span>
                      </div>
                      <p>{role.description}</p>
                      {assigned ? (
                        <Button
                          aria-label={`移除项目角色 ${role.name}`}
                          disabled={pending}
                          onClick={() => void removeRoleFromMember(role.id)}
                          size="compact"
                          type="button"
                          variant="danger"
                        >
                          移除角色
                        </Button>
                      ) : (
                        <Button
                          aria-label={`添加项目角色 ${role.name}`}
                          disabled={pending || !role.assignable}
                          onClick={() => void addRoleToMember(role.id)}
                          size="compact"
                          type="button"
                          variant="secondary"
                        >
                          添加角色
                        </Button>
                      )}
                    </article>
                  );
                })}
              </div>
              <div className="action-dialog-actions">
                <Button
                  disabled={pending}
                  onClick={() => setRoleDialogMember(null)}
                  type="button"
                  variant="secondary"
                >
                  完成
                </Button>
              </div>
            </div>
          ) : null}
        </ActionDialog>
      </section>

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Memberships</p>
            <h2>成员与已分配角色</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>状态</th>
                <th>角色</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan={4}>当前项目暂无成员。</td>
                </tr>
              ) : null}
              {members.map((member) => (
                <tr key={member.user.id}>
                  <td>
                    <strong>{member.user.displayName}</strong>
                    <small className="table-secondary">
                      {member.user.username} · {member.user.id}
                      {member.user.id === project.ownerUserId ? " · 当前负责人" : ""}
                    </small>
                  </td>
                  <td>{member.user.status === "active" ? "启用" : "禁用"}</td>
                  <td>
                    <div className="permission-list">
                      {member.roleIds.map((roleId) => (
                        <code key={roleId}>{roleName(roles, roleId)}</code>
                      ))}
                    </div>
                  </td>
                  <td>
                    {canManage && !project.archived ? (
                      <Button
                        aria-haspopup="dialog"
                        disabled={pending}
                        onClick={() => openMemberRoleDialog(member)}
                        size="compact"
                        type="button"
                        variant="secondary"
                      >
                        管理角色
                      </Button>
                    ) : (
                      "仅查看"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canManage ? (
          <p className="settings-note">
            点击成员行的“管理角色”可直接添加或移除项目角色。当前负责人最后一个项目管理角色受服务端保护；请先转移负责人再移除。所有角色变更都会撤销目标用户的旧会话。
          </p>
        ) : null}
      </section>
    </div>
  );
}

function roleName(roles: Role[], roleId: string): string {
  return roles.find((role) => role.id === roleId)?.name ?? roleId;
}

function manageableProjectRoles(
  roles: Role[],
  assignedRoleIds: readonly string[],
): Array<{ id: string; name: string; description: string; assignable: boolean }> {
  const projectRoles = roles
    .filter((role) => role.scope === "project")
    .map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description || "该角色没有补充说明。",
      assignable: role.active,
    }));
  const knownRoleIds = new Set(projectRoles.map((role) => role.id));
  return [
    ...projectRoles,
    ...assignedRoleIds
      .filter((roleId) => !knownRoleIds.has(roleId))
      .map((roleId) => ({
        id: roleId,
        name: roleId,
        description: "该角色已停用或当前不可分配，可以移除现有绑定。",
        assignable: false,
      })),
  ];
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
