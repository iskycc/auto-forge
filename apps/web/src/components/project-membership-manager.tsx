"use client";

import type { Project, Role, User } from "@autoforge/domain";
import { ShieldCheck, UserPlus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button, Input, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

type ProjectMember = { user: User; roleIds: string[] };
const RELOAD_MESSAGE_KEY = "autoforge:project-memberships:message";

export function ProjectMembershipManager({
  project,
  projects,
  members,
  roles,
  canManage,
}: {
  project: Project;
  projects: Project[];
  members: ProjectMember[];
  roles: Role[];
  canManage: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setMessage(takeReloadMessage());
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  async function request(path: string, init: RequestInit, success: string) {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(path, init);
      const errorMessage = await readApiErrorMessage(response, "操作失败。");
      if (errorMessage) throw new Error(errorMessage);
      window.sessionStorage.setItem(RELOAD_MESSAGE_KEY, success);
      window.location.reload();
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

  function transferOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ownerUserId = String(form.get("ownerUserId") ?? "");
    if (!window.confirm("转移负责人后，新负责人会自动获得项目管理能力。确认继续？")) return;
    void request(
      `/api/v1/projects/${project.id}/owner`,
      jsonRequest("POST", { ownerUserId }),
      "项目负责人已转移。",
    );
  }

  return (
    <div className="settings-stack">
      {message ? <div className="inline-success">{message}</div> : null}
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Project scope</p>
            <h2>{project.name}</h2>
            <p>
              {project.slug} · {project.archived ? "已归档" : "启用"} · 项目 ID {project.id}
            </p>
          </div>
          <ShieldCheck size={22} aria-hidden="true" />
        </div>
        <form action="/settings/projects" className="settings-user-filter" method="get">
          <label>
            授权项目
            <Select defaultValue={project.id} name="projectId">
              {projects.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.archived ? "（已归档）" : ""}
                </option>
              ))}
            </Select>
          </label>
          <Button className="secondary-button" type="submit">
            切换项目
          </Button>
        </form>

        {canManage && !project.archived ? (
          <div className="settings-paired-forms">
            <form className="settings-grid-form settings-subform" onSubmit={addMemberRole}>
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
            <form className="settings-grid-form settings-subform" onSubmit={transferOwner}>
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
          </div>
        ) : null}
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
                    <small>
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
                    {canManage && !project.archived
                      ? member.roleIds.map((roleId) => (
                          <Button
                            className="danger-text-button"
                            disabled={pending}
                            key={roleId}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `撤销“${roleName(roles, roleId)}”后会立即撤销该用户的旧会话。确认继续？`,
                                )
                              ) {
                                return;
                              }
                              void request(
                                `/api/v1/users/${member.user.id}/project-roles/${project.id}/${roleId}`,
                                { method: "DELETE" },
                                "项目角色已撤销。",
                              );
                            }}
                            type="button"
                          >
                            撤销 {roleName(roles, roleId)}
                          </Button>
                        ))
                      : "仅查看"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canManage ? (
          <p className="settings-note">
            当前负责人最后一个项目管理角色受服务端保护；请先转移负责人再撤销。所有角色变更都会撤销目标用户的旧会话。
          </p>
        ) : null}
      </section>
    </div>
  );
}

function roleName(roles: Role[], roleId: string): string {
  return roles.find((role) => role.id === roleId)?.name ?? roleId;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function takeReloadMessage(): string {
  if (typeof window === "undefined") return "";
  const message = window.sessionStorage.getItem(RELOAD_MESSAGE_KEY) ?? "";
  window.sessionStorage.removeItem(RELOAD_MESSAGE_KEY);
  return message;
}
