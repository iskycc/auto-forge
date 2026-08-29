"use client";

import { Button, CheckboxGroup, Input, Select, Textarea } from "@/components/ui";

import {
  permissionCatalog,
  type Project,
  type Role,
  type User,
  type UserSession,
} from "@autoforge/domain";
import { Network, Plus, RefreshCw, Search, Shield, ShieldAlert, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { readApiErrorMessage } from "@/lib/client-api";
import { permissionDescription, permissionLabel } from "@/lib/permission-presentation";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { ActionDialog } from "@/components/action-dialog";

type LdapView = {
  enabled: boolean;
  url: string;
  transportMode: "ldaps" | "starttls" | "plain";
  verifyTlsCertificate: boolean;
  caPem?: string;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
  pageSize: number;
  maximumUsers: number;
  synchronizationIntervalMinutes: number;
  bindDn: string;
  bindPasswordConfigured: boolean;
  userBaseDn: string;
  userFilter: string;
  usernameAttribute: string;
  displayNameAttribute: string;
  emailAttribute: string;
  groupAttribute: string;
  groupSearchBase: string;
  groupSearchFilter: string;
  groupNameAttribute: string;
  defaultRole: "admin" | "editor" | "viewer";
  version: number;
};

export type AccessSection = "users" | "roles" | "ldap" | "sessions";

export function AccessSettings({
  users,
  roles,
  projects,
  projectMemberships,
  ldap,
  ldapMappings,
  sessions,
  systemRoleBindings,
  userQuery,
  userSource,
  nextUserCursor,
  capabilities,
  activeSection,
}: {
  users: User[];
  roles: Role[];
  projects: Project[];
  projectMemberships: Array<{
    projectId: string;
    members: Array<{ user: User; roleIds: string[] }>;
  }>;
  ldap: LdapView | null;
  ldapMappings: Array<{
    id: string;
    groupDn: string;
    roleId: string;
    projectId?: string;
    priority: number;
  }>;
  sessions: UserSession[];
  systemRoleBindings: Array<{ userId: string; roleId: string }>;
  userQuery: string;
  userSource: "" | "local" | "ldap";
  nextUserCursor: string | undefined;
  capabilities: {
    userRead: boolean;
    userManage: boolean;
    roleRead: boolean;
    roleManage: boolean;
    projectRead: boolean;
    ldapRead: boolean;
    ldapManage: boolean;
  };
  activeSection: AccessSection;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [ldapEnabled, setLdapEnabled] = useState(ldap?.enabled ?? false);
  const [verifyLdapTlsCertificate, setVerifyLdapTlsCertificate] = useState(
    ldap?.verifyTlsCertificate ?? true,
  );
  const [clearLdapBindPassword, setClearLdapBindPassword] = useState(false);
  const [createDialog, setCreateDialog] = useState<
    "user" | "password" | "role" | "assignment" | null
  >(null);

  async function request(path: string, init: RequestInit, success: string) {
    setPending(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(path, init);
      const errorMessage = await readApiErrorMessage(response, "操作失败。");
      if (errorMessage) throw new Error(errorMessage);
      setMessage(success);
      setCreateDialog(null);
      router.refresh();
      setPending(false);
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
        permissions: form.getAll("permissions").map(String),
      }),
      "自定义角色已创建。",
    );
  }

  function submitRoleUpdate(event: FormEvent<HTMLFormElement>, roleId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      `/api/v1/roles/${roleId}`,
      jsonRequest("PATCH", {
        name: form.get("name"),
        description: form.get("description"),
        permissions: form.getAll("permissions").map(String),
      }),
      "角色定义已更新，受影响用户的旧会话已撤销。",
    );
  }

  function submitRoleCopy(event: FormEvent<HTMLFormElement>, role: Role) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void request(
      "/api/v1/roles",
      jsonRequest("POST", {
        key: form.get("key"),
        name: form.get("name"),
        description: role.description,
        scope: role.scope,
        permissions: role.permissions,
      }),
      "角色副本已创建，可继续编辑后再分配。",
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

  function submitLdapForm(formElement: HTMLFormElement, testOnly: boolean) {
    const form = new FormData(formElement);
    const payload = ldapPayload(form, ldap, ldapEnabled);
    void request(
      testOnly ? "/api/v1/ldap/test" : "/api/v1/ldap/configuration",
      jsonRequest(testOnly ? "POST" : "PUT", payload),
      testOnly
        ? payload.groupSearchBase
          ? "LDAP 连接、用户与 Group Base DN 验证成功。"
          : "LDAP 连接与用户 Base DN 验证成功。"
        : "LDAP 配置已加密保存。",
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

      {activeSection === "users" && capabilities.userRead ? (
        <section className="content-card settings-section" id="users">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Identity</p>
              <h2>用户管理</h2>
            </div>
            {capabilities.userManage ? (
              <div className="button-row">
                <Button onClick={() => setCreateDialog("password")} type="button">
                  重置密码
                </Button>
                <Button onClick={() => setCreateDialog("user")} type="button" variant="primary">
                  <Plus size={16} /> 创建用户
                </Button>
              </div>
            ) : (
              <UserRound size={22} aria-hidden="true" />
            )}
          </div>
          <ActionDialog
            description="创建本地账号后，用户首次登录必须修改初始密码。"
            onClose={() => !pending && setCreateDialog(null)}
            open={createDialog === "user"}
            title="创建本地用户"
          >
            <form className="settings-grid-form action-dialog-form" onSubmit={submitUser}>
              <label>
                用户名
                <Input name="username" required />
              </label>
              <label>
                显示名称
                <Input name="displayName" required />
              </label>
              <label>
                邮箱（可选）
                <Input name="email" type="email" />
              </label>
              <label>
                初始密码
                <Input minLength={12} name="password" required type="password" />
              </label>
              <Button className="primary-button" disabled={pending} type="submit">
                <Plus size={16} /> 创建本地用户
              </Button>
            </form>
          </ActionDialog>
          <ActionDialog
            description="重置后会立即撤销目标用户的所有旧会话。"
            onClose={() => !pending && setCreateDialog(null)}
            open={createDialog === "password"}
            title="重置用户密码"
          >
            <form className="settings-grid-form action-dialog-form" onSubmit={submitPasswordReset}>
              <label>
                本地用户
                <Select name="userId" required>
                  {users
                    .filter((user) => user.source === "local")
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName} · {user.username}
                      </option>
                    ))}
                </Select>
              </label>
              <label>
                新密码
                <Input minLength={12} name="password" required type="password" />
              </label>
              <Button className="secondary-button" disabled={pending} type="submit">
                重置密码并撤销会话
              </Button>
            </form>
          </ActionDialog>
          <form action="/settings/access" className="settings-user-filter" method="get">
            <input name="section" type="hidden" value="users" />
            <label>
              搜索用户
              <Input defaultValue={userQuery} maxLength={120} name="query" />
            </label>
            <label>
              账号来源
              <Select defaultValue={userSource} name="source">
                <option value="">全部来源</option>
                <option value="local">本地</option>
                <option value="ldap">LDAP</option>
              </Select>
            </label>
            <Button className="secondary-button" type="submit">
              <Search size={16} /> 筛选
            </Button>
          </form>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>最近登录</th>
                  <th>已分配角色</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.displayName}</strong>
                      <small className="table-secondary">
                        {user.username}
                        {user.email ? ` · ${user.email}` : ""} · {user.id}
                      </small>
                    </td>
                    <td>{user.source === "ldap" ? "LDAP" : "本地"}</td>
                    <td>
                      {user.status === "disabled"
                        ? "禁用"
                        : isUserLocked(user)
                          ? `锁定至 ${formatLocalDateTime(user.lockedUntil!)}`
                          : "启用"}
                    </td>
                    <td>{user.lastLoginAt ? formatLocalDateTime(user.lastLoginAt) : "—"}</td>
                    <td>
                      <details>
                        <summary className="role-action-summary">
                          {assignedRoleCount(user.id, systemRoleBindings, projectMemberships)}{" "}
                          个绑定
                        </summary>
                        <div className="permission-list">
                          {systemRoleBindings
                            .filter((binding) => binding.userId === user.id)
                            .map((binding) => (
                              <code key={`system-${binding.roleId}`}>
                                系统 · {roleName(roles, binding.roleId)}
                              </code>
                            ))}
                          {projectMemberships.flatMap((membership) =>
                            membership.members
                              .filter((member) => member.user.id === user.id)
                              .flatMap((member) =>
                                member.roleIds.map((roleId) => (
                                  <code key={`${membership.projectId}-${roleId}`}>
                                    {projectName(projects, membership.projectId)} ·{" "}
                                    {roleName(roles, roleId)}
                                  </code>
                                )),
                              ),
                          )}
                        </div>
                      </details>
                    </td>
                    <td>
                      {capabilities.userManage ? (
                        <>
                          <Button
                            className="table-action"
                            disabled={pending}
                            onClick={() =>
                              void request(
                                `/api/v1/users/${user.id}/status`,
                                jsonRequest("PATCH", {
                                  status:
                                    user.status === "active" && !isUserLocked(user)
                                      ? "disabled"
                                      : "active",
                                }),
                                user.status === "active" && !isUserLocked(user)
                                  ? "用户已禁用。"
                                  : "用户已启用并解除登录锁定。",
                              )
                            }
                            type="button"
                          >
                            {user.status === "active" && !isUserLocked(user) ? "禁用" : "启用/解锁"}
                          </Button>
                          <Button
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
                          </Button>
                        </>
                      ) : (
                        "仅查看"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextUserCursor ? (
            <a
              className="button button-secondary settings-next-page"
              href={userPageHref(userQuery, userSource, nextUserCursor)}
            >
              下一页
            </a>
          ) : null}
        </section>
      ) : null}

      {activeSection === "roles" && capabilities.roleRead ? (
        <section className="content-card settings-section" id="roles">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Authorization</p>
              <h2>角色与权限分层</h2>
            </div>
            {capabilities.roleManage ? (
              <div className="button-row">
                <Button onClick={() => setCreateDialog("assignment")} type="button">
                  分配角色
                </Button>
                <Button onClick={() => setCreateDialog("role")} type="button" variant="primary">
                  <Plus size={16} /> 创建角色
                </Button>
              </div>
            ) : (
              <Shield size={22} aria-hidden="true" />
            )}
          </div>
          <ActionDialog
            description="系统角色对全局生效，项目角色仅对选定项目生效。"
            onClose={() => !pending && setCreateDialog(null)}
            open={createDialog === "assignment"}
            title="分配用户角色"
          >
            <div className="settings-paired-forms">
              <form className="settings-grid-form settings-subform" onSubmit={submitSystemRole}>
                <label>
                  用户<Select name="userId">{users.map(userOption)}</Select>
                </label>
                <label>
                  系统角色
                  <Select name="roleId">
                    {roles.filter((role) => role.scope === "system" && role.active).map(roleOption)}
                  </Select>
                </label>
                <Button className="secondary-button" disabled={pending} type="submit">
                  分配系统角色
                </Button>
              </form>
              <form className="settings-grid-form settings-subform" onSubmit={submitProjectRole}>
                <label>
                  用户<Select name="userId">{users.map(userOption)}</Select>
                </label>
                <label>
                  项目
                  <Select name="projectId">
                    {projects.filter((project) => !project.archived).map(projectOption)}
                  </Select>
                </label>
                <label>
                  项目角色
                  <Select name="roleId">
                    {roles
                      .filter((role) => role.scope === "project" && role.active)
                      .map(roleOption)}
                  </Select>
                </label>
                <Button className="secondary-button" disabled={pending} type="submit">
                  分配项目角色
                </Button>
              </form>
            </div>
          </ActionDialog>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>系统角色</th>
                  <th>影响与操作</th>
                </tr>
              </thead>
              <tbody>
                {systemRoleBindings.length === 0 ? (
                  <tr>
                    <td colSpan={3}>当前没有系统角色绑定。</td>
                  </tr>
                ) : null}
                {systemRoleBindings.map((binding) => (
                  <tr key={`${binding.userId}-${binding.roleId}`}>
                    <td>{userName(users, binding.userId)}</td>
                    <td>{roleName(roles, binding.roleId)}</td>
                    <td>
                      <Button
                        className="danger-text-button"
                        disabled={pending || !capabilities.roleManage}
                        onClick={() => {
                          if (
                            !window.confirm(
                              "撤销系统角色会立即撤销目标用户的全部旧会话；最后一位系统管理员受服务端保护。确认继续？",
                            )
                          ) {
                            return;
                          }
                          void request(
                            `/api/v1/users/${binding.userId}/system-roles/${binding.roleId}`,
                            { method: "DELETE" },
                            "系统角色已撤销。",
                          );
                        }}
                        type="button"
                      >
                        撤销系统角色
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ActionDialog
            description="自定义角色用于组合系统级或项目级权限。"
            onClose={() => !pending && setCreateDialog(null)}
            open={createDialog === "role"}
            title="创建自定义角色"
          >
            <form className="settings-grid-form action-dialog-form" onSubmit={submitRole}>
              <label>
                角色标识
                <Input name="key" placeholder="release-operator" required />
              </label>
              <label>
                角色名称
                <Input name="name" required />
              </label>
              <label>
                作用域
                <Select defaultValue="project" name="scope">
                  <option value="project">项目</option>
                  <option value="system">系统</option>
                </Select>
              </label>
              <CheckboxGroup
                className="settings-wide-field"
                label="权限"
                name="permissions"
                options={permissionCatalog.map((permission) => ({
                  value: permission,
                  label: permissionLabel(permission),
                  description: permissionDescription(permission),
                }))}
                required
              />
              <label className="settings-wide-field">
                描述
                <Input name="description" />
              </label>
              <Button className="primary-button" disabled={pending} type="submit">
                <Plus size={16} /> 创建角色
              </Button>
            </form>
          </ActionDialog>
          <div className="role-grid">
            {roles.map((role) => (
              <article className="role-card" key={role.id}>
                <div>
                  <strong>{role.name}</strong>
                  <small>
                    {role.key} · {role.scope === "system" ? "系统" : "项目"}
                    {role.builtIn ? " · 内置" : role.active ? "" : " · 已停用"}
                  </small>
                </div>
                <p>{role.description || "无描述"}</p>
                <div className="permission-list">
                  {role.permissions.map((permission) => (
                    <span
                      className="permission-chip"
                      key={permission}
                      title={permissionDescription(permission)}
                    >
                      {permissionLabel(permission)}
                    </span>
                  ))}
                </div>
                {capabilities.roleManage ? (
                  <div className="role-actions">
                    <details>
                      <summary className="role-action-summary">复制角色</summary>
                      <form
                        className="settings-grid-form settings-subform"
                        onSubmit={(event) => submitRoleCopy(event, role)}
                      >
                        <label>
                          新角色标识
                          <Input defaultValue={`${role.key}-copy`} name="key" required />
                        </label>
                        <label>
                          新角色名称
                          <Input defaultValue={`${role.name} 副本`} name="name" required />
                        </label>
                        <Button className="secondary-button" disabled={pending} type="submit">
                          创建副本
                        </Button>
                      </form>
                    </details>
                    {!role.builtIn ? (
                      <>
                        <details>
                          <summary className="role-action-summary">编辑角色</summary>
                          <form
                            className="settings-grid-form settings-subform"
                            onSubmit={(event) => submitRoleUpdate(event, role.id)}
                          >
                            <label>
                              角色名称
                              <Input defaultValue={role.name} name="name" required />
                            </label>
                            <CheckboxGroup
                              className="settings-wide-field"
                              defaultValue={role.permissions}
                              label="权限"
                              name="permissions"
                              options={permissionCatalog.map((permission) => ({
                                value: permission,
                                label: permissionLabel(permission),
                                description: permissionDescription(permission),
                              }))}
                              required
                            />
                            <label className="settings-wide-field">
                              描述
                              <Input defaultValue={role.description} name="description" />
                            </label>
                            <Button className="secondary-button" disabled={pending} type="submit">
                              保存角色
                            </Button>
                          </form>
                        </details>
                        <Button
                          className="table-action"
                          disabled={pending}
                          onClick={() =>
                            void request(
                              `/api/v1/roles/${role.id}`,
                              jsonRequest("PATCH", { active: !role.active }),
                              role.active
                                ? "角色已停用，相关用户会话已撤销，停用角色不再授予权限。"
                                : "角色已重新启用。",
                            )
                          }
                          type="button"
                        >
                          {role.active ? "停用角色" : "启用角色"}
                        </Button>
                        <Button
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
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {activeSection === "ldap" && capabilities.ldapRead ? (
        <section className="content-card settings-section" id="ldap">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Directory</p>
              <h2>LDAP 配置</h2>
            </div>
            <Network size={22} aria-hidden="true" />
          </div>
          {capabilities.ldapManage ? (
            <form
              className="settings-grid-form"
              onSubmit={(event) => {
                event.preventDefault();
                submitLdapForm(event.currentTarget, false);
              }}
            >
              <label className="checkbox-field">
                <Input
                  checked={ldapEnabled}
                  name="enabled"
                  onChange={(event) => setLdapEnabled(event.target.checked)}
                  type="checkbox"
                />
                启用 LDAP 登录
              </label>
              <fieldset className="settings-form-fieldset" disabled={!ldapEnabled}>
                <div className="form-context-summary settings-wide-field">
                  <span>01 · 服务器</span>
                  <strong>连接内网 LDAP 或 Active Directory</strong>
                  <small>
                    389 通常填写 ldap://；636 和 AD 全局编录 3269 会按 LDAPS 处理并自动规范地址。
                  </small>
                </div>
                <label className="settings-wide-field">
                  LDAP 服务地址
                  <Input
                    defaultValue={ldap?.url ?? "ldaps://ldap.internal:636"}
                    name="url"
                    placeholder="ldaps://ldap.example.local:636"
                    required
                  />
                </label>
                <label>
                  连接超时（毫秒）
                  <Input
                    defaultValue={ldap?.connectTimeoutMs ?? 5000}
                    max={30000}
                    min={1000}
                    name="connectTimeoutMs"
                    step={500}
                    type="number"
                  />
                </label>
                <label className="checkbox-field settings-wide-field">
                  <Input
                    checked={verifyLdapTlsCertificate}
                    name="verifyTlsCertificate"
                    onChange={(event) => setVerifyLdapTlsCertificate(event.target.checked)}
                    type="checkbox"
                  />
                  校验 TLS 服务器证书
                </label>
                {!verifyLdapTlsCertificate ? (
                  <div className="inline-notice warning-notice settings-wide-field" role="alert">
                    <ShieldAlert size={18} />
                    <span>
                      {
                        "关闭后 TLS 连接无法确认服务器身份，存在中间人攻击风险；也不会为 ldap:// 明文连接增加加密。仅限可信隔离内网。"
                      }
                    </span>
                  </div>
                ) : null}
                <div className="form-context-summary settings-wide-field">
                  <span>02 · 服务账户</span>
                  <strong>用于搜索用户 DN</strong>
                  <small>Bind DN 留空时使用匿名目录检索。</small>
                </div>
                <label>
                  Bind DN（可选）
                  <Input
                    autoComplete="off"
                    defaultValue={ldap?.bindDn}
                    name="bindDn"
                    placeholder="cn=service,ou=system,dc=example,dc=local"
                  />
                </label>
                <label>
                  Bind 密码
                  <Input
                    name="bindPassword"
                    placeholder={
                      ldap?.bindPasswordConfigured ? "留空以保持现有密文" : "Bind DN 非空时必填"
                    }
                    type="password"
                  />
                </label>
                {ldap?.bindPasswordConfigured ? (
                  <label className="checkbox-field settings-wide-field">
                    <Input
                      checked={clearLdapBindPassword}
                      name="clearBindPassword"
                      onChange={(event) => setClearLdapBindPassword(event.target.checked)}
                      type="checkbox"
                    />
                    删除已保存的服务账户密码
                  </label>
                ) : null}
                {ldap?.transportMode === "starttls" ? (
                  <div className="inline-notice warning-notice settings-wide-field" role="status">
                    当前历史配置继续使用 StartTLS，保存其他字段不会降级连接。修改 LDAP
                    服务地址后将按新地址切换为 URL 驱动的 LDAP/LDAPS。
                  </div>
                ) : null}
                <div className="form-context-summary settings-wide-field">
                  <span>03 · 用户检索与纳管</span>
                  <strong>首次目录登录自动创建平台用户</strong>
                  <small>过滤器中的登录名会按 RFC 4515 规则安全转义。</small>
                </div>
                <label className="settings-wide-field">
                  用户 Base DN
                  <Input defaultValue={ldap?.userBaseDn} name="userBaseDn" required />
                </label>
                <label className="settings-wide-field">
                  用户过滤器
                  <Input
                    defaultValue={ldap?.userFilter ?? "(&(objectClass=person)(uid={{username}}))"}
                    name="userFilter"
                    required
                  />
                  <small>必须包含 {"{{username}}"} 占位符。</small>
                </label>
                <label>
                  用户名属性
                  <Input defaultValue={ldap?.usernameAttribute ?? "uid"} name="usernameAttribute" />
                </label>
                <label>
                  显示名称属性
                  <Input
                    defaultValue={ldap?.displayNameAttribute ?? "displayName"}
                    name="displayNameAttribute"
                  />
                </label>
                <label>
                  邮箱属性（可选）
                  <Input defaultValue={ldap?.emailAttribute ?? "mail"} name="emailAttribute" />
                </label>
                <label>
                  新 LDAP 用户默认角色
                  <Select defaultValue={ldap?.defaultRole ?? "editor"} name="defaultRole">
                    <option value="editor">测试管理员（默认项目）</option>
                    <option value="viewer">只读观察者（默认项目）</option>
                    <option value="admin">系统管理员</option>
                  </Select>
                  <small>只在用户首次成功登录或首次同步纳管时分配。</small>
                </label>
                <div className="form-context-summary settings-wide-field">
                  <span>04 · Group 检索</span>
                  <strong>同步目录组并用于角色映射</strong>
                  <small>留空 Group Search Base 时读取用户条目的多值 Group 属性。</small>
                </div>
                <label className="settings-wide-field">
                  Group Search Base（可选）
                  <Input defaultValue={ldap?.groupSearchBase} name="groupSearchBase" />
                </label>
                <label className="settings-wide-field">
                  Group Search Filter
                  <Input
                    defaultValue={ldap?.groupSearchFilter ?? "(member={{userDn}})"}
                    name="groupSearchFilter"
                  />
                  <small>
                    必须包含 {"{{userDn}}"} 或 {"{{username}}"} 占位符。
                  </small>
                </label>
                <label>
                  Group 名称属性
                  <Input
                    defaultValue={ldap?.groupNameAttribute ?? "cn"}
                    name="groupNameAttribute"
                  />
                </label>
                <label>
                  用户 Group 属性（兼容模式）
                  <Input defaultValue={ldap?.groupAttribute ?? "memberOf"} name="groupAttribute" />
                  <small>Active Directory 通常为 memberOf。</small>
                </label>
                <div className="form-context-summary settings-wide-field">
                  <span>05 · 同步策略</span>
                  <strong>AutoForge 目录同步边界</strong>
                  <small>限制分页、单次纳管数量与后台同步频率。</small>
                </div>
                <label>
                  LDAP 分页大小
                  <Input
                    defaultValue={ldap?.pageSize ?? 500}
                    max={1000}
                    min={50}
                    name="pageSize"
                    type="number"
                  />
                </label>
                <label>
                  单次同步用户上限
                  <Input
                    defaultValue={ldap?.maximumUsers ?? 5000}
                    max={50000}
                    min={1}
                    name="maximumUsers"
                    type="number"
                  />
                </label>
                <label>
                  计划同步间隔（分钟，0 为关闭）
                  <Input
                    defaultValue={ldap?.synchronizationIntervalMinutes ?? 0}
                    max={10080}
                    min={0}
                    name="synchronizationIntervalMinutes"
                    type="number"
                  />
                </label>
                <label className="settings-wide-field">
                  私有 CA PEM（可选）
                  <Textarea defaultValue={ldap?.caPem} name="caPem" rows={5} />
                </label>
              </fieldset>
              <div className="settings-form-actions">
                <Button
                  className="secondary-button"
                  disabled={pending || !ldapEnabled}
                  onClick={(event) => {
                    const form = event.currentTarget.form;
                    if (form) submitLdapForm(form, true);
                  }}
                  type="button"
                >
                  <RefreshCw size={16} /> 测试连接
                </Button>
                <Button
                  className="primary-button"
                  disabled={pending || (!ldapEnabled && !ldap)}
                  type="submit"
                >
                  保存 LDAP 配置
                </Button>
              </div>
            </form>
          ) : (
            <dl className="stat-list">
              <div>
                <dt>状态</dt>
                <dd>{ldap?.enabled ? "启用" : "停用"}</dd>
              </div>
              <div>
                <dt>协议</dt>
                <dd>
                  {ldap?.transportMode === "starttls"
                    ? "StartTLS（兼容）"
                    : ldap?.url.startsWith("ldaps://")
                      ? "LDAPS"
                      : "LDAP"}
                </dd>
              </div>
              <div>
                <dt>证书校验</dt>
                <dd>{ldap?.verifyTlsCertificate === false ? "已关闭" : "已开启"}</dd>
              </div>
              <div>
                <dt>目录地址</dt>
                <dd>{ldap?.url || "未配置"}</dd>
              </div>
            </dl>
          )}
          {capabilities.ldapManage ? (
            <div className="settings-directory-actions">
              <Button
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
              </Button>
            </div>
          ) : null}
          {capabilities.ldapManage ? (
            <form className="settings-grid-form settings-subform" onSubmit={submitLdapMapping}>
              <label className="settings-wide-field">
                LDAP Group 标识
                <Input name="groupDn" required />
              </label>
              <label>
                角色<Select name="roleId">{roles.map(roleOption)}</Select>
              </label>
              <label>
                项目（系统角色留空）
                <Select defaultValue="" name="projectId">
                  <option value="">系统作用域</option>
                  {projects.filter((project) => !project.archived).map(projectOption)}
                </Select>
              </label>
              <label>
                优先级
                <Input defaultValue={0} max={1000} min={-1000} name="priority" type="number" />
              </label>
              <Button className="secondary-button" disabled={pending} type="submit">
                添加组映射
              </Button>
            </form>
          ) : null}
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
      ) : null}

      {activeSection === "sessions" ? (
        <section className="content-card settings-section" id="sessions">
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
                    <td>{formatLocalDateTime(session.createdAt)}</td>
                    <td>{formatLocalDateTime(session.lastSeenAt)}</td>
                    <td>{formatLocalDateTime(session.expiresAt)}</td>
                    <td>
                      <Button
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
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
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

function roleName(roles: Role[], roleId: string): string {
  return roles.find((role) => role.id === roleId)?.name ?? roleId;
}

function userName(users: User[], userId: string): string {
  const user = users.find((candidate) => candidate.id === userId);
  return user ? `${user.displayName} · ${user.username}` : userId;
}

function isUserLocked(user: User): boolean {
  return Boolean(user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now());
}

function projectName(projects: Project[], projectId: string): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId;
}

function assignedRoleCount(
  userId: string,
  systemRoleBindings: Array<{ userId: string; roleId: string }>,
  projectMemberships: Array<{
    projectId: string;
    members: Array<{ user: User; roleIds: string[] }>;
  }>,
): number {
  return (
    systemRoleBindings.filter((binding) => binding.userId === userId).length +
    projectMemberships.reduce(
      (count, membership) =>
        count +
        (membership.members.find((member) => member.user.id === userId)?.roleIds.length ?? 0),
      0,
    )
  );
}

function ldapPayload(form: FormData, current: LdapView | null, enabled: boolean) {
  if (!enabled && current) {
    return {
      enabled: false,
      url: current.url,
      ...(current.transportMode === "starttls" ? { tlsMode: "starttls" } : {}),
      verifyTlsCertificate: current.verifyTlsCertificate,
      caPem: current.caPem,
      connectTimeoutMs: current.connectTimeoutMs,
      operationTimeoutMs: current.operationTimeoutMs,
      pageSize: current.pageSize,
      maximumUsers: current.maximumUsers,
      synchronizationIntervalMinutes: current.synchronizationIntervalMinutes,
      bindDn: current.bindDn,
      userBaseDn: current.userBaseDn,
      userFilter: current.userFilter,
      usernameAttribute: current.usernameAttribute,
      displayNameAttribute: current.displayNameAttribute,
      emailAttribute: current.emailAttribute,
      groupAttribute: current.groupAttribute,
      groupSearchBase: current.groupSearchBase,
      groupSearchFilter: current.groupSearchFilter,
      groupNameAttribute: current.groupNameAttribute,
      defaultRole: current.defaultRole,
    };
  }
  const optional = (name: string) => String(form.get(name) ?? "").trim() || undefined;
  const url = String(form.get("url") ?? "").trim();
  return {
    enabled,
    url,
    ...(current?.transportMode === "starttls" && current.url === url
      ? { tlsMode: "starttls" }
      : {}),
    verifyTlsCertificate: form.has("verifyTlsCertificate"),
    caPem: optional("caPem"),
    connectTimeoutMs: Number(form.get("connectTimeoutMs") ?? 5_000),
    operationTimeoutMs: current?.operationTimeoutMs ?? 10_000,
    pageSize: Number(form.get("pageSize") ?? 500),
    maximumUsers: Number(form.get("maximumUsers") ?? 5_000),
    synchronizationIntervalMinutes: Number(form.get("synchronizationIntervalMinutes") ?? 0),
    bindDn: form.get("bindDn"),
    bindPassword: optional("bindPassword"),
    clearBindPassword: form.has("clearBindPassword"),
    userBaseDn: form.get("userBaseDn"),
    userFilter: form.get("userFilter"),
    usernameAttribute: form.get("usernameAttribute"),
    displayNameAttribute: form.get("displayNameAttribute"),
    emailAttribute: form.get("emailAttribute"),
    groupAttribute: form.get("groupAttribute"),
    groupSearchBase: optional("groupSearchBase") ?? "",
    groupSearchFilter: optional("groupSearchFilter") ?? "(member={{userDn}})",
    groupNameAttribute: form.get("groupNameAttribute"),
    defaultRole: form.get("defaultRole"),
  };
}

function userPageHref(query: string, source: string, cursor: string): string {
  const parameters = new URLSearchParams({ cursor, section: "users" });
  if (query) parameters.set("query", query);
  if (source) parameters.set("source", source);
  return `/settings/access?${parameters}`;
}
