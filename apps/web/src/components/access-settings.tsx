"use client";

import type { AuditEvent, Project, Role, User, UserSession } from "@autoforge/domain";
import { Network, Plus, RefreshCw, Search, Shield, UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";

type LdapView = {
  enabled: boolean;
  urls: string[];
  tlsMode: "ldaps" | "starttls";
  caPem?: string;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
  pageSize: number;
  maximumUsers: number;
  bindDn: string;
  bindPasswordConfigured: boolean;
  userBaseDn: string;
  userFilter: string;
  userIdAttribute: string;
  usernameAttribute: string;
  displayNameAttribute: string;
  emailAttribute: string;
  groupBaseDn?: string;
  groupFilter?: string;
  groupMemberAttribute: string;
  version: number;
};

export function AccessSettings({
  users,
  roles,
  projects,
  ldap,
  ldapMappings,
  sessions,
  auditEvents,
  userQuery,
  userSource,
  nextUserCursor,
}: {
  users: User[];
  roles: Role[];
  projects: Project[];
  ldap: LdapView | null;
  ldapMappings: Array<{
    id: string;
    groupDn: string;
    roleId: string;
    projectId?: string;
    priority: number;
  }>;
  sessions: UserSession[];
  auditEvents: AuditEvent[];
  userQuery: string;
  userSource: "" | "local" | "ldap";
  nextUserCursor: string | undefined;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function request(path: string, init: RequestInit, success: string) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(path, init);
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? "操作失败。");
      }
      setMessage(success);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
      setPending(false);
    }
  }

  function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      "/api/v1/users",
      jsonRequest("POST", {
        username: form.get("username"),
        displayName: form.get("displayName"),
        email: form.get("email") || undefined,
        password: form.get("password"),
        forcePasswordChange: true,
      }),
      "本地用户已创建。",
    );
  }

  function submitRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      "/api/v1/roles",
      jsonRequest("POST", {
        key: form.get("key"),
        name: form.get("name"),
        description: form.get("description"),
        scope: form.get("scope"),
        permissions: String(form.get("permissions") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      }),
      "自定义角色已创建。",
    );
  }

  function submitPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      `/api/v1/users/${String(form.get("userId"))}/password`,
      jsonRequest("PUT", { password: form.get("password"), forcePasswordChange: true }),
      "密码已重置，目标用户的已有会话已撤销。",
    );
  }

  function submitSystemRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      `/api/v1/users/${String(form.get("userId"))}/system-roles`,
      jsonRequest("POST", { roleId: form.get("roleId") }),
      "系统角色已分配，旧会话已撤销。",
    );
  }

  function submitProjectRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      `/api/v1/users/${String(form.get("userId"))}/project-roles`,
      jsonRequest("POST", { projectId: form.get("projectId"), roleId: form.get("roleId") }),
      "项目成员角色已分配。",
    );
  }

  function submitLdapMapping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const projectId = String(form.get("projectId") ?? "");
    void request(
      "/api/v1/ldap/group-mappings",
      jsonRequest("POST", {
        groupDn: form.get("groupDn"),
        roleId: form.get("roleId"),
        ...(projectId ? { projectId } : {}),
        priority: Number(form.get("priority") ?? 0),
      }),
      "LDAP 组角色映射已添加。",
    );
  }

  function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      "/api/v1/projects",
      jsonRequest("POST", { name: form.get("name"), slug: form.get("slug") }),
      "项目已创建。",
    );
  }

  function submitLdapForm(formElement: HTMLFormElement, testOnly: boolean) {
    const form = new FormData(formElement);
    const payload = ldapPayload(form);
    void request(
      testOnly ? "/api/v1/ldap/test" : "/api/v1/ldap/configuration",
      jsonRequest(testOnly ? "POST" : "PUT", payload),
      testOnly ? "LDAP 连接、TLS 和 bind 验证成功。" : "LDAP 配置已加密保存。",
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
            <p className="eyebrow">Identity</p>
            <h2>用户管理</h2>
          </div>
          <UserRound size={22} aria-hidden="true" />
        </div>
        <form className="settings-grid-form" onSubmit={submitUser}>
          <label>
            用户名
            <input name="username" required />
          </label>
          <label>
            显示名称
            <input name="displayName" required />
          </label>
          <label>
            邮箱（可选）
            <input name="email" type="email" />
          </label>
          <label>
            初始密码
            <input minLength={12} name="password" required type="password" />
          </label>
          <button className="primary-button" disabled={pending} type="submit">
            <Plus size={16} /> 创建本地用户
          </button>
        </form>
        <form action="/settings/access" className="settings-user-filter" method="get">
          <label>
            搜索用户
            <input defaultValue={userQuery} maxLength={120} name="query" />
          </label>
          <label>
            账号来源
            <select defaultValue={userSource} name="source">
              <option value="">全部来源</option>
              <option value="local">本地</option>
              <option value="ldap">LDAP</option>
            </select>
          </label>
          <button className="secondary-button" type="submit">
            <Search size={16} /> 筛选
          </button>
        </form>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>来源</th>
                <th>状态</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.displayName}</strong>
                    <small>
                      {user.username}
                      {user.email ? ` · ${user.email}` : ""} · {user.id}
                    </small>
                  </td>
                  <td>{user.source === "ldap" ? "LDAP" : "本地"}</td>
                  <td>{user.status === "active" ? "启用" : "禁用"}</td>
                  <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "—"}</td>
                  <td>
                    <button
                      className="table-action"
                      disabled={pending}
                      onClick={() =>
                        void request(
                          `/api/v1/users/${user.id}/status`,
                          jsonRequest("PATCH", {
                            status: user.status === "active" ? "disabled" : "active",
                          }),
                          user.status === "active" ? "用户已禁用。" : "用户已启用并解锁。",
                        )
                      }
                      type="button"
                    >
                      {user.status === "active" ? "禁用" : "启用/解锁"}
                    </button>
                    <button
                      className="table-action"
                      disabled={pending}
                      onClick={() =>
                        void request(
                          `/api/v1/users/${user.id}/sessions`,
                          { method: "DELETE" },
                          "该用户的全部会话已撤销。",
                        )
                      }
                      type="button"
                    >
                      撤销会话
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nextUserCursor ? (
          <a
            className="secondary-button settings-next-page"
            href={userPageHref(userQuery, userSource, nextUserCursor)}
          >
            下一页
          </a>
        ) : null}
        <form className="settings-grid-form settings-subform" onSubmit={submitPasswordReset}>
          <label>
            本地用户
            <select name="userId" required>
              {users
                .filter((user) => user.source === "local")
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName} · {user.username}
                  </option>
                ))}
            </select>
          </label>
          <label>
            新密码
            <input minLength={12} name="password" required type="password" />
          </label>
          <button className="secondary-button" disabled={pending} type="submit">
            重置密码并撤销会话
          </button>
        </form>
      </section>

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Authorization</p>
            <h2>角色与权限分层</h2>
          </div>
          <Shield size={22} aria-hidden="true" />
        </div>
        <div className="settings-paired-forms">
          <form className="settings-grid-form settings-subform" onSubmit={submitSystemRole}>
            <label>
              用户<select name="userId">{users.map(userOption)}</select>
            </label>
            <label>
              系统角色
              <select name="roleId">
                {roles.filter((role) => role.scope === "system").map(roleOption)}
              </select>
            </label>
            <button className="secondary-button" disabled={pending} type="submit">
              分配系统角色
            </button>
          </form>
          <form className="settings-grid-form settings-subform" onSubmit={submitProjectRole}>
            <label>
              用户<select name="userId">{users.map(userOption)}</select>
            </label>
            <label>
              项目
              <select name="projectId">
                {projects.filter((project) => !project.archived).map(projectOption)}
              </select>
            </label>
            <label>
              项目角色
              <select name="roleId">
                {roles.filter((role) => role.scope === "project").map(roleOption)}
              </select>
            </label>
            <button className="secondary-button" disabled={pending} type="submit">
              分配项目角色
            </button>
          </form>
        </div>
        <form className="settings-grid-form" onSubmit={submitRole}>
          <label>
            角色标识
            <input name="key" placeholder="release-operator" required />
          </label>
          <label>
            角色名称
            <input name="name" required />
          </label>
          <label>
            作用域
            <select defaultValue="project" name="scope">
              <option value="project">项目</option>
              <option value="system">系统</option>
            </select>
          </label>
          <label className="settings-wide-field">
            权限（英文逗号分隔）
            <input name="permissions" placeholder="case.read,run.read,run.create" required />
          </label>
          <label className="settings-wide-field">
            描述
            <input name="description" />
          </label>
          <button className="primary-button" disabled={pending} type="submit">
            <Plus size={16} /> 创建角色
          </button>
        </form>
        <div className="role-grid">
          {roles.map((role) => (
            <article className="role-card" key={role.id}>
              <div>
                <strong>{role.name}</strong>
                <small>
                  {role.key} · {role.scope === "system" ? "系统" : "项目"}
                </small>
              </div>
              <p>{role.description || "无描述"}</p>
              <div className="permission-list">
                {role.permissions.map((permission) => (
                  <code key={permission}>{permission}</code>
                ))}
              </div>
              {!role.builtIn ? (
                <button
                  className="danger-text-button"
                  disabled={pending}
                  onClick={() =>
                    void request(
                      `/api/v1/roles/${role.id}`,
                      { method: "DELETE" },
                      "自定义角色已删除。",
                    )
                  }
                  type="button"
                >
                  删除角色
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Projects</p>
            <h2>项目作用域</h2>
          </div>
        </div>
        <form className="settings-grid-form" onSubmit={submitProject}>
          <label>
            项目名称
            <input name="name" required />
          </label>
          <label>
            Slug
            <input name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
          </label>
          <button className="primary-button" disabled={pending} type="submit">
            <Plus size={16} /> 创建项目
          </button>
        </form>
        <div className="project-settings-list">
          {projects.map((project) => (
            <div className="project-settings-item" key={project.id}>
              <code>
                {project.name} · {project.slug}
                {project.isDefault ? " · 默认" : ""}
                {project.archived ? " · 已归档" : ""}
              </code>
              {!project.isDefault && !project.archived ? (
                <button
                  className="danger-text-button"
                  disabled={pending}
                  onClick={() =>
                    void request(
                      `/api/v1/projects/${project.id}`,
                      { method: "DELETE" },
                      "项目已归档。",
                    )
                  }
                  type="button"
                >
                  归档
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Directory</p>
            <h2>LDAP 配置</h2>
          </div>
          <Network size={22} aria-hidden="true" />
        </div>
        <form
          className="settings-grid-form"
          onSubmit={(event) => {
            event.preventDefault();
            submitLdapForm(event.currentTarget, false);
          }}
        >
          <label className="checkbox-field">
            <input defaultChecked={ldap?.enabled ?? false} name="enabled" type="checkbox" />
            启用 LDAP 登录
          </label>
          <label>
            TLS 模式
            <select defaultValue={ldap?.tlsMode ?? "ldaps"} name="tlsMode">
              <option value="ldaps">LDAPS</option>
              <option value="starttls">StartTLS</option>
            </select>
          </label>
          <label className="settings-wide-field">
            服务器地址（每行一个）
            <textarea
              defaultValue={ldap?.urls.join("\n") ?? "ldaps://ldap.internal:636"}
              name="urls"
              required
              rows={2}
            />
          </label>
          <label>
            Bind DN
            <input defaultValue={ldap?.bindDn} name="bindDn" required />
          </label>
          <label>
            Bind 密码
            <input
              name="bindPassword"
              placeholder={ldap?.bindPasswordConfigured ? "留空以保持现有密文" : "必填"}
              required={!ldap?.bindPasswordConfigured}
              type="password"
            />
          </label>
          <label>
            LDAP 分页大小
            <input
              defaultValue={ldap?.pageSize ?? 500}
              max={1000}
              min={50}
              name="pageSize"
              type="number"
            />
          </label>
          <label>
            单次同步用户上限
            <input
              defaultValue={ldap?.maximumUsers ?? 5000}
              max={50000}
              min={1}
              name="maximumUsers"
              type="number"
            />
          </label>
          <label className="settings-wide-field">
            用户 Base DN
            <input defaultValue={ldap?.userBaseDn} name="userBaseDn" required />
          </label>
          <label className="settings-wide-field">
            用户过滤器
            <input
              defaultValue={ldap?.userFilter ?? "(&(objectClass=person)(uid={username}))"}
              name="userFilter"
              required
            />
          </label>
          <label>
            稳定 ID 属性
            <input defaultValue={ldap?.userIdAttribute ?? "entryUUID"} name="userIdAttribute" />
          </label>
          <label>
            用户名属性
            <input defaultValue={ldap?.usernameAttribute ?? "uid"} name="usernameAttribute" />
          </label>
          <label>
            显示名属性
            <input
              defaultValue={ldap?.displayNameAttribute ?? "displayName"}
              name="displayNameAttribute"
            />
          </label>
          <label>
            邮箱属性
            <input defaultValue={ldap?.emailAttribute ?? "mail"} name="emailAttribute" />
          </label>
          <label className="settings-wide-field">
            组 Base DN（可选）
            <input defaultValue={ldap?.groupBaseDn} name="groupBaseDn" />
          </label>
          <label className="settings-wide-field">
            组过滤器（可选，使用 {"{userDn}"}）
            <input defaultValue={ldap?.groupFilter} name="groupFilter" />
          </label>
          <label className="settings-wide-field">
            私有 CA PEM（可选）
            <textarea defaultValue={ldap?.caPem} name="caPem" rows={5} />
          </label>
          <div className="settings-form-actions">
            <button
              className="secondary-button"
              disabled={pending}
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (form) submitLdapForm(form, true);
              }}
              type="button"
            >
              <RefreshCw size={16} /> 测试连接
            </button>
            <button className="primary-button" disabled={pending} type="submit">
              保存 LDAP 配置
            </button>
          </div>
        </form>
        <div className="settings-directory-actions">
          <button
            className="secondary-button"
            disabled={pending || !ldap?.enabled}
            onClick={() =>
              void request(
                "/api/v1/ldap/synchronize",
                { method: "POST" },
                "LDAP 用户、组和停用状态同步完成。",
              )
            }
            type="button"
          >
            <RefreshCw size={16} /> 立即同步目录
          </button>
        </div>
        <form className="settings-grid-form settings-subform" onSubmit={submitLdapMapping}>
          <label className="settings-wide-field">
            LDAP 组 DN
            <input name="groupDn" required />
          </label>
          <label>
            角色<select name="roleId">{roles.map(roleOption)}</select>
          </label>
          <label>
            项目（系统角色留空）
            <select defaultValue="" name="projectId">
              <option value="">系统作用域</option>
              {projects.filter((project) => !project.archived).map(projectOption)}
            </select>
          </label>
          <label>
            优先级
            <input defaultValue={0} max={1000} min={-1000} name="priority" type="number" />
          </label>
          <button className="secondary-button" disabled={pending} type="submit">
            添加组映射
          </button>
        </form>
        <div className="permission-list">
          {ldapMappings.map((mapping) => (
            <code key={mapping.id}>
              {mapping.groupDn} →{" "}
              {roles.find((role) => role.id === mapping.roleId)?.name ?? mapping.roleId}
              {mapping.projectId
                ? ` · ${projects.find((project) => project.id === mapping.projectId)?.name ?? mapping.projectId}`
                : " · 系统"}{" "}
              · 优先级 {mapping.priority}
            </code>
          ))}
        </div>
      </section>

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Sessions</p>
            <h2>当前账号会话</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>创建时间</th>
                <th>最近活动</th>
                <th>过期时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>{new Date(session.createdAt).toLocaleString()}</td>
                  <td>{new Date(session.lastSeenAt).toLocaleString()}</td>
                  <td>{new Date(session.expiresAt).toLocaleString()}</td>
                  <td>
                    <button
                      className="danger-text-button"
                      disabled={pending}
                      onClick={() =>
                        void request(
                          `/api/v1/sessions/${session.id}`,
                          { method: "DELETE" },
                          "会话已终止。",
                        )
                      }
                      type="button"
                    >
                      终止
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Audit</p>
            <h2>近期安全审计</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>结果</th>
                <th>主体</th>
                <th>资源</th>
              </tr>
            </thead>
            <tbody>
              {auditEvents.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.recordedAt).toLocaleString()}</td>
                  <td>{event.action}</td>
                  <td>{event.result}</td>
                  <td>{event.actorId ?? event.actorType}</td>
                  <td>
                    {event.resourceType}
                    {event.resourceId ? ` · ${event.resourceId}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function userOption(user: User) {
  return (
    <option key={user.id} value={user.id}>
      {user.displayName} · {user.username}
    </option>
  );
}

function roleOption(role: Role) {
  return (
    <option key={role.id} value={role.id}>
      {role.name}
    </option>
  );
}

function projectOption(project: Project) {
  return (
    <option key={project.id} value={project.id}>
      {project.name}
    </option>
  );
}

function ldapPayload(form: FormData) {
  const optional = (name: string) => String(form.get(name) ?? "").trim() || undefined;
  return {
    enabled: form.get("enabled") === "on",
    urls: String(form.get("urls") ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    tlsMode: form.get("tlsMode"),
    caPem: optional("caPem"),
    connectTimeoutMs: 5_000,
    operationTimeoutMs: 10_000,
    pageSize: Number(form.get("pageSize") ?? 500),
    maximumUsers: Number(form.get("maximumUsers") ?? 5_000),
    bindDn: form.get("bindDn"),
    bindPassword: optional("bindPassword"),
    userBaseDn: form.get("userBaseDn"),
    userFilter: form.get("userFilter"),
    userIdAttribute: form.get("userIdAttribute"),
    usernameAttribute: form.get("usernameAttribute"),
    displayNameAttribute: form.get("displayNameAttribute"),
    emailAttribute: form.get("emailAttribute"),
    groupBaseDn: optional("groupBaseDn"),
    groupFilter: optional("groupFilter"),
    groupMemberAttribute: "member",
  };
}

function userPageHref(query: string, source: string, cursor: string): string {
  const parameters = new URLSearchParams({ cursor });
  if (query) parameters.set("query", query);
  if (source) parameters.set("source", source);
  return `/settings/access?${parameters}`;
}
