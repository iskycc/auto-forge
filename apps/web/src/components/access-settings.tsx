"use client";
import { Badge } from "@/components/ui/badge";

import { Notice } from "@/components/ui/notice";

import { Disclosure } from "@/components/ui/disclosure";

import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { Button, CheckboxGroup, Input, Select } from "@/components/ui";

import {
  permissionCatalog,
  type Project,
  type Role,
  type User,
  type UserSession,
} from "@autoforge/domain";
import { Network, Plus, RefreshCw, Search, Shield, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { ExpandableText } from "./expandable-text";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { readApiErrorMessage } from "@/lib/client-api";
import {
  permissionDescription,
  permissionLabel,
  permissionGroup,
} from "@/lib/permission-presentation";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { UserPicker } from "./user-picker";
import { CursorPagination } from "./cursor-pagination";
import { ActionDialog } from "@/components/action-dialog";
import { CreateUserDialog } from "@/components/create-user-dialog";
import { UserRoleAssignmentDialog } from "@/components/user-role-assignment-dialog";
import { useConfirm, useToast } from "@/components/ui-feedback";

type LdapView = {
  enabled: boolean;
  url: string;
  tlsRejectUnauthorized: boolean;
  connectTimeoutMs: number;
  bindDn: string;
  hasBindPassword: boolean;
  userBaseDn: string;
  userFilter: string;
  displayNameAttribute: string;
  mailAttribute: string;
  groupAttribute: string;
  groupSearchBase: string;
  groupSearchFilter: string;
  groupNameAttribute: string;
  defaultRole: "admin" | "editor" | "viewer";
  updatedAt: string | null;
  updatedBy: string;
};

export type AccessSection = "users" | "roles" | "ldap" | "sessions";

export function AccessSettings({
  currentSessionId,
  users,
  roles,
  projects,
  assignableProjectIds,
  projectMemberships,
  ldap,
  sessions,
  systemRoleBindings,
  userQuery,
  userSource,
  nextUserCursor,
  capabilities,
  activeSection,
  projectScope,
  currentProject,
  canReadAllUsers,
  canReadSystemRoles,
}: {
  projectScope: boolean;
  currentProject?: Project;
  canReadAllUsers: boolean;
  canReadSystemRoles: boolean;
  users: User[];
  roles: Role[];
  projects: Project[];
  assignableProjectIds: string[];
  projectMemberships: Array<{
    projectId: string;
    members: Array<{ user: User; roleIds: string[] }>;
  }>;
  ldap: LdapView | null;
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
    systemRoleAssign: boolean;
    projectRead: boolean;
    ldapRead: boolean;
    ldapManage: boolean;
  };
  currentSessionId?: string;
  activeSection: AccessSection;
}) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const toast = useToast();
  const [error, setError] = useState("");
  const [roleQuery, setRoleQuery] = useState("");
  const [roleScope, setRoleScope] = useState(canReadSystemRoles ? "" : "project");
  const [pending, setPending] = useState(false);
  const [ldapEnabled, setLdapEnabled] = useState(ldap?.enabled ?? false);
  const [tlsRejectUnauthorized, setTlsRejectUnauthorized] = useState(
    ldap?.tlsRejectUnauthorized ?? true,
  );
  const [hasLdapBindPassword, setHasLdapBindPassword] = useState(ldap?.hasBindPassword ?? false);
  const [clearLdapBindPassword, setClearLdapBindPassword] = useState(false);
  const [createDialog, setCreateDialog] = useState<
    "user" | "password" | "role" | "assignment" | null
  >(null);
  const [roleAssignmentUser, setRoleAssignmentUser] = useState<User | null>(null);
  const assignableProjectSet = new Set(assignableProjectIds);
  const assignableProjects = projects.filter((project) => assignableProjectSet.has(project.id));
  const userScopeUrl = `/settings/access?section=users${projectScope ? "&scope=project" : ""}`;
  const canAssignRoles =
    capabilities.roleRead && (capabilities.systemRoleAssign || assignableProjects.length > 0);

  async function request(
    path: string,
    init: RequestInit,
    success: string,
    { refreshPage = true }: { refreshPage?: boolean } = {},
  ): Promise<boolean> {
    setPending(true);
    setError("");
    try {
      const response = await fetch(path, init);
      const errorMessage = await readApiErrorMessage(response, "操作失败。");
      if (errorMessage) throw new Error(errorMessage);
      toast.success(success);
      setCreateDialog(null);
      if (refreshPage) router.refresh();
      setPending(false);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
      setPending(false);
      return false;
    }
  }

  async function endOtherSessions() {
    if (
      !(await confirmAction({
        title: "退出其他会话",
        description: "保留当前登录，其他浏览器需要重新登录。",
        confirmLabel: "确认退出",
        tone: "danger",
      }))
    )
      return;
    setPending(true);
    setError("");
    try {
      for (const session of sessions.filter((item) => item.id !== currentSessionId)) {
        const response = await fetch(`/api/v1/sessions/${encodeURIComponent(session.id)}`, {
          method: "DELETE",
        });
        const message = await readApiErrorMessage(response, "结束会话失败，已完成的操作会保留。");
        if (message) throw new Error(message);
      }
      toast.success("其他登录会话已终止，当前登录保留。");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求未完成。");
    } finally {
      setPending(false);
    }
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

  async function changeUserStatus(user: User): Promise<void> {
    const disable = user.status === "active" && !isUserLocked(user);
    if (
      disable &&
      !(await confirmAction({
        title: "禁用用户",
        description: `禁用“${user.displayName}”后，该用户的登录会话立即失效。`,
        confirmLabel: "确认变更",
        tone: "warning",
      }))
    )
      return;
    await request(
      `/api/v1/users/${user.id}/status`,
      jsonRequest("PATCH", { status: disable ? "disabled" : "active" }),
      disable ? "用户已禁用。" : "用户已启用并解除登录锁定。",
    );
  }

  function submitPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!form.get("userId")) {
      setError("请先查询并选择需要重置密码的用户。");
      return;
    }
    void request(
      `/api/v1/users/${String(form.get("userId"))}/password`,
      jsonRequest("PUT", { password: form.get("password"), forcePasswordChange: true }),
      "密码已重置，目标用户的已有会话已撤销。",
    );
  }

  async function submitLdapForm(formElement: HTMLFormElement, action: "save" | "test") {
    const testOnly = action === "test";
    const form = new FormData(formElement);
    const payload = ldapPayload(form, ldap, ldapEnabled);
    const succeeded = await request(
      testOnly ? "/api/v1/ldap/test" : "/api/v1/ldap/configuration",
      jsonRequest(testOnly ? "POST" : "PUT", payload),
      testOnly
        ? payload.groupSearchBase
          ? "LDAP 连接、用户与 Group Base DN 验证成功。"
          : "LDAP 连接与用户 Base DN 验证成功。"
        : "LDAP 配置已加密保存。",
      { refreshPage: false },
    );
    if (!succeeded || testOnly) return;

    const bindPasswordInput = formElement.elements.namedItem("bindPassword");
    if (bindPasswordInput instanceof HTMLInputElement) bindPasswordInput.value = "";
    setHasLdapBindPassword(
      Boolean(payload.bindPassword) || (!payload.clearBindPassword && hasLdapBindPassword),
    );
    setClearLdapBindPassword(false);
  }

  return (
    <div className={cn("settings-stack", uiPatterns["settings-stack"])}>
      {error && !createDialog ? (
        <Notice tone="error" className={cn("auth-error", uiPatterns["auth-error"])} role="alert">
          {error}
        </Notice>
      ) : null}
      {createDialog === "assignment" && canAssignRoles ? (
        <UserRoleAssignmentDialog
          canAssignSystemRoles={capabilities.systemRoleAssign}
          onAssigned={(message) => {
            setCreateDialog(null);
            toast.success(message);
            router.refresh();
          }}
          onClose={() => setCreateDialog(null)}
          projects={assignableProjects}
          roles={roles}
          selectedUser={roleAssignmentUser}
          assignedRoles={
            roleAssignmentUser
              ? [
                  ...systemRoleBindings
                    .filter((binding) => binding.userId === roleAssignmentUser.id)
                    .map((binding) => ({ roleId: binding.roleId })),
                  ...projectMemberships.flatMap((membership) =>
                    membership.members
                      .filter((member) => member.user.id === roleAssignmentUser.id)
                      .flatMap((member) =>
                        member.roleIds.map((roleId) => ({
                          roleId,
                          projectId: membership.projectId,
                        })),
                      ),
                  ),
                ]
              : []
          }
        />
      ) : null}

      {activeSection === "users" && capabilities.userRead ? (
        <Card
          as="section"
          className={cn(
            "content-card settings-section",
            uiPatterns["content-card"],
            uiPatterns["settings-section"],
          )}
          id="users"
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <h2>用户列表</h2>
            </div>
            <div className={cn("button-row", uiPatterns["button-row"])}>
              {projectScope && canAssignRoles ? (
                <Button
                  onClick={() => {
                    setRoleAssignmentUser(null);
                    setCreateDialog("assignment");
                  }}
                  type="button"
                  variant="primary"
                >
                  <Plus size={16} /> 添加成员
                </Button>
              ) : null}
              {capabilities.userManage ? (
                <>
                  <Button onClick={() => (setError(""), setCreateDialog("password"))} type="button">
                    重置密码
                  </Button>
                  <Button onClick={() => setCreateDialog("user")} type="button" variant="primary">
                    <Plus size={16} /> 创建用户
                  </Button>
                </>
              ) : null}
            </div>
          </div>
          {createDialog === "user" ? (
            <CreateUserDialog
              onClose={() => setCreateDialog(null)}
              onCreated={() => {
                setCreateDialog(null);
                toast.success("本地用户已创建。");
                router.refresh();
              }}
            />
          ) : null}
          <ActionDialog
            protectUnsavedChanges
            description="重置后会立即撤销目标用户的所有旧会话。"
            onClose={() => !pending && setCreateDialog(null)}
            open={createDialog === "password"}
            title="重置用户密码"
          >
            <form
              className={cn(
                "settings-grid-form action-dialog-form",
                uiPatterns["settings-grid-form"],
                accessSettingsStyles["action-dialog-form"],
              )}
              onSubmit={submitPasswordReset}
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
              <UserPicker purpose="password" />
              <label>
                新密码
                <Input minLength={12} name="password" required type="password" />
              </label>
              <Button
                className={cn("secondary-button", uiPatterns["secondary-button"])}
                disabled={pending}
                type="submit"
              >
                重置密码并撤销会话
              </Button>
            </form>
          </ActionDialog>
          <div className={cn("access-scope-toolbar", accessSettingsStyles["access-scope-toolbar"])}>
            <nav
              aria-label="用户管理范围"
              className={cn("access-scope-options", accessSettingsStyles["access-scope-options"])}
            >
              {canReadAllUsers ? (
                <Link
                  aria-current={!projectScope ? "page" : undefined}
                  href="/settings/access?section=users"
                >
                  全平台用户
                </Link>
              ) : null}
              {capabilities.projectRead ? (
                <Link
                  aria-current={projectScope ? "page" : undefined}
                  href="/settings/access?section=users&scope=project"
                >
                  当前项目成员
                </Link>
              ) : null}
            </nav>
            <span className={cn("settings-note", uiPatterns["settings-note"])}>
              {projectScope
                ? `项目：${currentProject?.name ?? "暂无可访问项目"}`
                : "账号统一创建，角色按系统或项目分配"}
            </span>
          </div>
          <form
            action="/settings/access"
            className={cn("settings-user-filter", accessSettingsStyles["settings-user-filter"])}
            method="get"
          >
            <input name="section" type="hidden" value="users" />
            {projectScope ? <input name="scope" type="hidden" value="project" /> : null}
            <label>
              搜索用户
              <Input defaultValue={userQuery} maxLength={120} name="query" />
            </label>
            {!projectScope ? (
              <label>
                账号来源
                <Select defaultValue={userSource} name="source">
                  <option value="">全部来源</option>
                  <option value="local">本地</option>
                  <option value="ldap">LDAP</option>
                </Select>
              </label>
            ) : null}
            <Button
              className={cn("secondary-button", uiPatterns["secondary-button"])}
              type="submit"
            >
              <Search size={16} /> 筛选
            </Button>
          </form>
          <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
            <Table
              className={cn(
                "data-table access-users-table",
                uiPatterns["data-table"],
                accessSettingsStyles["access-users-table"],
              )}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>最近登录</TableHead>
                  <TableHead>已分配角色</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!users.length ? (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
                        没有匹配的用户。请调整条件或
                        <Link href={userScopeUrl}>清空筛选</Link>。
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <strong>
                        <ExpandableText text={user.displayName} label="用户显示名称" />
                      </strong>
                      {projectScope && user.id === currentProject?.ownerUserId ? (
                        <Badge className={cn("permission-chip", uiPatterns["permission-chip"])}>
                          负责人
                        </Badge>
                      ) : null}
                      <small className={cn("table-secondary", uiPatterns["table-secondary"])}>
                        {user.username}
                        {user.email ? ` · ${user.email}` : ""}
                      </small>
                      {user.source === "ldap" && user.groups?.length ? (
                        <small
                          className={cn("table-secondary", uiPatterns["table-secondary"])}
                          title={user.groups.join("\n")}
                        >
                          Group · {user.groups.join("、")}
                        </small>
                      ) : null}
                    </TableCell>
                    <TableCell>{user.source === "ldap" ? "LDAP" : "本地"}</TableCell>
                    <TableCell>
                      {user.status === "disabled"
                        ? "禁用"
                        : isUserLocked(user)
                          ? `锁定至 ${formatLocalDateTime(user.lockedUntil!)}`
                          : "启用"}
                    </TableCell>
                    <TableCell>
                      {user.lastLoginAt ? formatLocalDateTime(user.lastLoginAt) : "—"}
                    </TableCell>
                    <TableCell>
                      <Disclosure
                        header={
                          <>
                            {assignedRoleCount(user.id, systemRoleBindings, projectMemberships)}{" "}
                            个绑定
                          </>
                        }
                        headerClassName={cn(
                          "role-action-summary",
                          accessSettingsStyles["role-action-summary"],
                        )}
                      >
                        <div
                          className={cn("permission-list", accessSettingsStyles["permission-list"])}
                        >
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
                      </Disclosure>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "access-user-actions",
                        accessSettingsStyles["access-user-actions"],
                      )}
                    >
                      {canAssignRoles ? (
                        <Button
                          className={cn(
                            "table-action access-role-assignment",
                            accessSettingsStyles["table-action"],
                          )}
                          disabled={pending}
                          onClick={() => {
                            setRoleAssignmentUser(user);
                            setCreateDialog("assignment");
                          }}
                          type="button"
                        >
                          分配角色
                        </Button>
                      ) : null}
                      {capabilities.userManage ? (
                        <>
                          <Disclosure
                            header={<>更多操作</>}
                            className={cn(
                              "row-more-actions",
                              accessSettingsStyles["row-more-actions"],
                            )}
                          >
                            <div>
                              <Button
                                className={cn("table-action", accessSettingsStyles["table-action"])}
                                disabled={pending}
                                onClick={() => void changeUserStatus(user)}
                                type="button"
                              >
                                {user.status === "active" && !isUserLocked(user)
                                  ? "禁用"
                                  : "启用/解锁"}
                              </Button>
                              <Button
                                className={cn("table-action", accessSettingsStyles["table-action"])}
                                disabled={pending}
                                onClick={() =>
                                  void confirmAction({
                                    title: "撤销用户会话",
                                    description: `“${user.displayName}”需要重新登录，确认撤销其所有会话？`,
                                    confirmLabel: "确认撤销",
                                    tone: "danger",
                                  }).then(
                                    (accepted) =>
                                      accepted &&
                                      request(
                                        `/api/v1/users/${user.id}/sessions`,
                                        { method: "DELETE" },
                                        "该用户的全部会话已撤销。",
                                      ),
                                  )
                                }
                                type="button"
                              >
                                撤销会话
                              </Button>
                            </div>
                          </Disclosure>
                        </>
                      ) : !canAssignRoles ? (
                        "仅查看"
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <CursorPagination nextCursor={nextUserCursor} count={users.length} label="用户分页" />
        </Card>
      ) : null}

      {activeSection === "roles" && capabilities.roleRead ? (
        <Card
          as="section"
          className={cn(
            "content-card settings-section",
            uiPatterns["content-card"],
            uiPatterns["settings-section"],
          )}
          id="roles"
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Authorization</p>
              <h2>角色与权限分层</h2>
            </div>
            {capabilities.roleManage || canAssignRoles ? (
              <div className={cn("button-row", uiPatterns["button-row"])}>
                {canAssignRoles ? (
                  <Button
                    onClick={() => {
                      setRoleAssignmentUser(null);
                      setCreateDialog("assignment");
                    }}
                    type="button"
                  >
                    分配角色
                  </Button>
                ) : null}
                {capabilities.roleManage ? (
                  <Button
                    onClick={() => (setError(""), setCreateDialog("role"))}
                    type="button"
                    variant="primary"
                  >
                    <Plus size={16} /> 创建角色
                  </Button>
                ) : null}
              </div>
            ) : (
              <Shield size={22} aria-hidden="true" />
            )}
          </div>
          {canReadSystemRoles ? (
            <Disclosure
              header={<>用户系统角色绑定</>}
              className={cn("management-disclosure", accessSettingsStyles["management-disclosure"])}
              defaultOpen={Boolean(userQuery)}
            >
              <form
                action="/settings/access"
                className={cn("settings-user-filter", accessSettingsStyles["settings-user-filter"])}
                method="get"
              >
                <input name="section" type="hidden" value="roles" />
                <label>
                  搜索用户绑定
                  <Input defaultValue={userQuery} maxLength={120} name="query" />
                </label>
                <Button type="submit">筛选绑定</Button>
              </form>{" "}
              <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
                <Table className={cn("data-table", uiPatterns["data-table"])}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>系统角色</TableHead>
                      <TableHead>影响与操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {systemRoleBindings.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3}>当前没有系统角色绑定。</TableCell>
                      </TableRow>
                    ) : null}
                    {systemRoleBindings.map((binding) => (
                      <TableRow key={`${binding.userId}-${binding.roleId}`}>
                        <TableCell>{userName(users, binding.userId)}</TableCell>
                        <TableCell>{roleName(roles, binding.roleId)}</TableCell>
                        <TableCell>
                          <Button
                            className={cn("danger-text-button", uiPatterns["danger-text-button"])}
                            disabled={pending || !capabilities.roleManage}
                            onClick={() => {
                              void confirmAction({
                                title: "撤销系统角色",
                                description:
                                  "目标用户的全部旧会话会立即失效；最后一位系统管理员仍受服务端保护。",
                                confirmLabel: "确认撤销",
                                tone: "danger",
                              }).then((accepted) => {
                                if (!accepted) return;
                                void request(
                                  `/api/v1/users/${binding.userId}/system-roles/${binding.roleId}`,
                                  { method: "DELETE" },
                                  "系统角色已撤销。",
                                );
                              });
                            }}
                            type="button"
                          >
                            撤销系统角色
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <CursorPagination
                nextCursor={nextUserCursor}
                count={systemRoleBindings.length}
                label="用户绑定分页"
              />
            </Disclosure>
          ) : null}
          <ActionDialog
            protectUnsavedChanges
            description="自定义角色用于组合系统级或项目级权限。"
            onClose={() => !pending && setCreateDialog(null)}
            open={createDialog === "role"}
            title="创建自定义角色"
          >
            <form
              className={cn(
                "settings-grid-form action-dialog-form",
                uiPatterns["settings-grid-form"],
                accessSettingsStyles["action-dialog-form"],
              )}
              onSubmit={submitRole}
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
                className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}
                label="权限"
                name="permissions"
                options={permissionCatalog.map((permission) => ({
                  value: permission,
                  label: permissionLabel(permission),
                  group: permissionGroup(permission),
                  description: permissionDescription(permission),
                }))}
                required
              />
              <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
                描述
                <Input name="description" />
              </label>
              <Button
                className={cn("primary-button", uiPatterns["primary-button"])}
                disabled={pending}
                type="submit"
              >
                <Plus size={16} /> 创建角色
              </Button>
            </form>
          </ActionDialog>
          <div className={cn("management-toolbar", uiPatterns["management-toolbar"])}>
            <label>
              搜索角色
              <Input
                type="search"
                value={roleQuery}
                onChange={(event) => setRoleQuery(event.target.value)}
              />
            </label>
            <label>
              角色范围
              <Select value={roleScope} onChange={(event) => setRoleScope(event.target.value)}>
                {canReadSystemRoles ? <option value="">全部范围</option> : null}
                {canReadSystemRoles ? <option value="system">系统</option> : null}
                <option value="project">项目</option>
              </Select>
            </label>
          </div>
          <div className={cn("role-grid", accessSettingsStyles["role-grid"])}>
            {roles
              .filter(
                (role) =>
                  (!roleScope || role.scope === roleScope) &&
                  `${role.name} ${role.key} ${role.description}`
                    .toLocaleLowerCase()
                    .includes(roleQuery.toLocaleLowerCase()),
              )
              .map((role) => (
                <article
                  className={cn("role-card", accessSettingsStyles["role-card"])}
                  key={role.id}
                >
                  <div>
                    <strong>{role.name}</strong>
                    <small>
                      {role.key} · {role.scope === "system" ? "系统" : "项目"}
                      {role.builtIn ? " · 内置" : role.active ? "" : " · 已停用"}
                    </small>
                  </div>
                  <p>{role.description || "无描述"}</p>
                  <Disclosure
                    header={<>{role.permissions.length} 项权限 · 查看明细</>}
                    className={cn(
                      "management-disclosure",
                      accessSettingsStyles["management-disclosure"],
                    )}
                  >
                    <div className={cn("permission-list", accessSettingsStyles["permission-list"])}>
                      {role.permissions.map((permission) => (
                        <Badge
                          className={cn("permission-chip", uiPatterns["permission-chip"])}
                          key={permission}
                          title={permissionDescription(permission)}
                        >
                          {permissionLabel(permission)}
                        </Badge>
                      ))}
                    </div>
                  </Disclosure>
                  {capabilities.roleManage ? (
                    <div className={cn("role-actions", accessSettingsStyles["role-actions"])}>
                      <Disclosure
                        header={<>复制角色</>}
                        headerClassName={cn(
                          "role-action-summary",
                          accessSettingsStyles["role-action-summary"],
                        )}
                      >
                        <form
                          className={cn(
                            "settings-grid-form settings-subform",
                            uiPatterns["settings-grid-form"],
                            uiPatterns["settings-subform"],
                          )}
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
                          <Button
                            className={cn("secondary-button", uiPatterns["secondary-button"])}
                            disabled={pending}
                            type="submit"
                          >
                            创建副本
                          </Button>
                        </form>
                      </Disclosure>
                      {!role.builtIn ? (
                        <>
                          <Disclosure
                            header={<>编辑角色</>}
                            headerClassName={cn(
                              "role-action-summary",
                              accessSettingsStyles["role-action-summary"],
                            )}
                          >
                            <form
                              className={cn(
                                "settings-grid-form settings-subform",
                                uiPatterns["settings-grid-form"],
                                uiPatterns["settings-subform"],
                              )}
                              onSubmit={(event) => submitRoleUpdate(event, role.id)}
                            >
                              <label>
                                角色名称
                                <Input defaultValue={role.name} name="name" required />
                              </label>
                              <CheckboxGroup
                                className={cn(
                                  "settings-wide-field",
                                  uiPatterns["settings-wide-field"],
                                )}
                                defaultValue={role.permissions}
                                label="权限"
                                name="permissions"
                                options={permissionCatalog.map((permission) => ({
                                  value: permission,
                                  label: permissionLabel(permission),
                                  group: permissionGroup(permission),
                                  description: permissionDescription(permission),
                                }))}
                                required
                              />
                              <label
                                className={cn(
                                  "settings-wide-field",
                                  uiPatterns["settings-wide-field"],
                                )}
                              >
                                描述
                                <Input defaultValue={role.description} name="description" />
                              </label>
                              <Button
                                className={cn("secondary-button", uiPatterns["secondary-button"])}
                                disabled={pending}
                                type="submit"
                              >
                                保存角色
                              </Button>
                            </form>
                          </Disclosure>
                          <Button
                            className={cn("table-action", accessSettingsStyles["table-action"])}
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
                            className={cn("danger-text-button", uiPatterns["danger-text-button"])}
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
        </Card>
      ) : null}

      {activeSection === "ldap" && capabilities.ldapRead ? (
        <Card
          as="section"
          className={cn(
            "content-card settings-section",
            uiPatterns["content-card"],
            uiPatterns["settings-section"],
          )}
          id="ldap"
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Directory</p>
              <h2>LDAP 配置</h2>
            </div>
            <Network size={22} aria-hidden="true" />
          </div>
          {capabilities.ldapManage ? (
            <form
              className={cn("settings-grid-form", uiPatterns["settings-grid-form"])}
              onSubmit={(event) => {
                event.preventDefault();
                void submitLdapForm(event.currentTarget, "save");
              }}
            >
              <label className={cn("checkbox-field", uiPatterns["checkbox-field"])}>
                <Input
                  checked={ldapEnabled}
                  name="enabled"
                  onChange={(event) => setLdapEnabled(event.target.checked)}
                  type="checkbox"
                />
                启用 LDAP 登录
              </label>
              {!ldapEnabled ? (
                <p className={cn("settings-note", uiPatterns["settings-note"])}>
                  LDAP 登录已关闭。启用后可编辑连接、用户检索与默认角色；关闭不会删除已保存的配置。
                </p>
              ) : null}
              <fieldset
                hidden={!ldapEnabled}
                className={cn(
                  "settings-form-fieldset",
                  accessSettingsStyles["settings-form-fieldset"],
                )}
                disabled={!ldapEnabled}
              >
                <div
                  className={cn(
                    "form-context-summary settings-wide-field",
                    accessSettingsStyles["form-context-summary"],
                    uiPatterns["settings-wide-field"],
                  )}
                >
                  <span>01 · 服务器</span>
                  <strong>连接内网 LDAP 或 Active Directory</strong>
                  <small>
                    389 通常填写 ldap://；636 和 AD 全局编录 3269 会按 LDAPS 处理并自动规范地址。
                  </small>
                </div>
                <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
                  LDAP 服务地址
                  <Input
                    defaultValue={ldap?.url || "ldaps://ldap.internal:636"}
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
                <label
                  className={cn(
                    "checkbox-field settings-wide-field",
                    uiPatterns["checkbox-field"],
                    uiPatterns["settings-wide-field"],
                  )}
                >
                  <Input
                    checked={tlsRejectUnauthorized}
                    name="tlsRejectUnauthorized"
                    onChange={(event) => setTlsRejectUnauthorized(event.target.checked)}
                    type="checkbox"
                  />
                  校验 TLS 服务器证书
                </label>
                {!tlsRejectUnauthorized ? (
                  <Notice
                    tone="warning"
                    className={cn(
                      "inline-notice warning-notice settings-wide-field",
                      uiPatterns["inline-notice"],
                      uiPatterns["warning-notice"],
                      uiPatterns["settings-wide-field"],
                    )}
                    role="alert"
                  >
                    <ShieldAlert size={18} />
                    <span>
                      {
                        "关闭后 TLS 连接无法确认服务器身份，存在中间人攻击风险；也不会为 ldap:// 明文连接增加加密。仅限可信隔离内网。"
                      }
                    </span>
                  </Notice>
                ) : null}
                <div
                  className={cn(
                    "form-context-summary settings-wide-field",
                    accessSettingsStyles["form-context-summary"],
                    uiPatterns["settings-wide-field"],
                  )}
                >
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
                    placeholder={hasLdapBindPassword ? "留空以保持现有密文" : "Bind DN 非空时必填"}
                    type="password"
                  />
                </label>
                {hasLdapBindPassword ? (
                  <label
                    className={cn(
                      "checkbox-field settings-wide-field",
                      uiPatterns["checkbox-field"],
                      uiPatterns["settings-wide-field"],
                    )}
                  >
                    <Input
                      checked={clearLdapBindPassword}
                      name="clearBindPassword"
                      onChange={(event) => setClearLdapBindPassword(event.target.checked)}
                      type="checkbox"
                    />
                    删除已保存的服务账户密码
                  </label>
                ) : null}
                <div
                  className={cn(
                    "form-context-summary settings-wide-field",
                    accessSettingsStyles["form-context-summary"],
                    uiPatterns["settings-wide-field"],
                  )}
                >
                  <span>03 · 用户检索与纳管</span>
                  <strong>首次目录登录自动创建平台用户</strong>
                  <small>过滤器中的登录名会按 RFC 4515 规则安全转义。</small>
                </div>
                <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
                  用户 Base DN
                  <Input defaultValue={ldap?.userBaseDn} name="userBaseDn" required />
                </label>
                <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
                  用户过滤器
                  <Input
                    defaultValue={ldap?.userFilter ?? "(uid={{username}})"}
                    name="userFilter"
                    required
                  />
                  <small>必须包含 {"{{username}}"} 占位符。</small>
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
                  <Input defaultValue={ldap?.mailAttribute ?? "mail"} name="mailAttribute" />
                </label>
                <label>
                  LDAP 用户统一角色
                  <Select defaultValue={ldap?.defaultRole ?? "editor"} name="defaultRole">
                    <option value="editor">测试管理员（默认项目）</option>
                    <option value="viewer">只读观察者（默认项目）</option>
                    <option value="admin">系统管理员</option>
                  </Select>
                  <small>LDAP 用户统一使用该平台角色，目录 Group 不参与权限分配。</small>
                </label>
                <div
                  className={cn(
                    "form-context-summary settings-wide-field",
                    accessSettingsStyles["form-context-summary"],
                    uiPatterns["settings-wide-field"],
                  )}
                >
                  <span>04 · Group 获取与展示</span>
                  <strong>Group 仅保存到用户档案</strong>
                  <small>Group 不创建角色绑定，也不会提升或降低任何平台权限。</small>
                </div>
                <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
                  Group Search Base（可选）
                  <Input defaultValue={ldap?.groupSearchBase} name="groupSearchBase" />
                  <small>留空时读取用户条目的 Group 属性。</small>
                </label>
                <label className={cn("settings-wide-field", uiPatterns["settings-wide-field"])}>
                  Group Search Filter
                  <Input
                    defaultValue={ldap?.groupSearchFilter ?? "(member={{userDn}})"}
                    name="groupSearchFilter"
                  />
                  <small>
                    配置 Group Search Base 时必须包含 {"{{userDn}}"} 或 {"{{username}}"}。
                  </small>
                </label>
                <label>
                  Group 名称属性
                  <Input
                    defaultValue={ldap?.groupNameAttribute || "cn"}
                    name="groupNameAttribute"
                  />
                </label>
                <label>
                  用户 Group 属性
                  <Input defaultValue={ldap?.groupAttribute || "memberOf"} name="groupAttribute" />
                  <small>未配置 Group Search Base 时通常填写 memberOf。</small>
                </label>
              </fieldset>
              <div
                className={cn(
                  "settings-form-actions",
                  accessSettingsStyles["settings-form-actions"],
                )}
              >
                <Button
                  className={cn("secondary-button", uiPatterns["secondary-button"])}
                  disabled={pending || !ldapEnabled}
                  onClick={(event) => {
                    const form = event.currentTarget.form;
                    if (form) void submitLdapForm(form, "test");
                  }}
                  type="button"
                >
                  <RefreshCw size={16} /> 测试连接
                </Button>
                <Button
                  className={cn("primary-button", uiPatterns["primary-button"])}
                  disabled={pending || (!ldapEnabled && !ldap)}
                  type="submit"
                >
                  保存 LDAP 配置
                </Button>
              </div>
            </form>
          ) : (
            <dl className={cn("stat-list", accessSettingsStyles["stat-list"])}>
              <div>
                <dt>状态</dt>
                <dd>{ldap?.enabled ? "启用" : "停用"}</dd>
              </div>
              <div>
                <dt>协议</dt>
                <dd>{ldap?.url.startsWith("ldaps://") ? "LDAPS" : "LDAP"}</dd>
              </div>
              <div>
                <dt>证书校验</dt>
                <dd>{ldap?.tlsRejectUnauthorized === false ? "已关闭" : "已开启"}</dd>
              </div>
              <div>
                <dt>目录地址</dt>
                <dd>{ldap?.url || "未配置"}</dd>
              </div>
            </dl>
          )}
          <Notice
            tone="info"
            className={cn(
              "inline-notice settings-directory-actions",
              uiPatterns["inline-notice"],
              accessSettingsStyles["settings-directory-actions"],
            )}
            role="status"
          >
            LDAP Group 仅用于用户档案展示；平台不会根据 Group 创建或修改任何权限绑定。
          </Notice>
        </Card>
      ) : null}

      {activeSection === "sessions" ? (
        <Card
          as="section"
          className={cn(
            "content-card settings-section",
            uiPatterns["content-card"],
            uiPatterns["settings-section"],
          )}
          id="sessions"
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Sessions</p>
              <h2>当前账号会话</h2>
            </div>
            <Button
              type="button"
              disabled={
                pending ||
                !currentSessionId ||
                !sessions.some((item) => item.id !== currentSessionId)
              }
              onClick={() => void endOtherSessions()}
            >
              退出其他会话
            </Button>
          </div>
          <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
            <Table className={cn("data-table", uiPatterns["data-table"])}>
              <TableHeader>
                <TableRow>
                  <TableHead>创建时间</TableHead>
                  <TableHead>最近活动</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>
                      {formatLocalDateTime(session.createdAt)}
                      {session.id === currentSessionId ? (
                        <Badge className={cn("permission-chip", uiPatterns["permission-chip"])}>
                          当前会话
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>{formatLocalDateTime(session.lastSeenAt)}</TableCell>
                    <TableCell>{formatLocalDateTime(session.expiresAt)}</TableCell>
                    <TableCell>
                      <Button
                        className={cn("danger-text-button", uiPatterns["danger-text-button"])}
                        disabled={pending}
                        onClick={() =>
                          void confirmAction({
                            title: "终止登录会话",
                            description:
                              session.id === currentSessionId
                                ? "这是当前正在使用的会话，终止后需要重新登录。"
                                : "终止后，对应浏览器需要重新登录。",
                            confirmLabel: "确认终止",
                            tone: "danger",
                          }).then((accepted) =>
                            accepted
                              ? request(
                                  `/api/v1/sessions/${session.id}`,
                                  { method: "DELETE" },
                                  "会话已终止。",
                                )
                              : undefined,
                          )
                        }
                        type="button"
                      >
                        终止
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
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
      tlsRejectUnauthorized: current.tlsRejectUnauthorized,
      connectTimeoutMs: current.connectTimeoutMs,
      bindDn: current.bindDn,
      userBaseDn: current.userBaseDn,
      userFilter: current.userFilter,
      displayNameAttribute: current.displayNameAttribute,
      mailAttribute: current.mailAttribute,
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
    tlsRejectUnauthorized: form.has("tlsRejectUnauthorized"),
    connectTimeoutMs: Number(form.get("connectTimeoutMs") ?? 5_000),
    bindDn: form.get("bindDn"),
    bindPassword: optional("bindPassword"),
    clearBindPassword: form.has("clearBindPassword"),
    userBaseDn: form.get("userBaseDn"),
    userFilter: form.get("userFilter"),
    displayNameAttribute: form.get("displayNameAttribute"),
    mailAttribute: form.get("mailAttribute"),
    groupAttribute: form.get("groupAttribute") ?? "memberOf",
    groupSearchBase: optional("groupSearchBase") ?? "",
    groupSearchFilter: optional("groupSearchFilter") ?? "(member={{userDn}})",
    groupNameAttribute: form.get("groupNameAttribute") ?? "cn",
    defaultRole: form.get("defaultRole"),
  };
}

const accessSettingsStyles = {
  "access-scope-options":
    'flex flex-wrap gap-1 p-1 rounded-lg bg-muted border border-solid border-border [&_>_a]:py-2 [&_>_a]:px-3 [&_>_a]:rounded-lg [&_>_a]:text-muted-foreground [&_>_a]:text-sm [&_>_a]:[text-decoration:none] [&_>_a[aria-current="page"]]:bg-card [&_>_a[aria-current="page"]]:text-info [&_>_a[aria-current="page"]]:shadow-lg',
  "access-scope-toolbar":
    "flex items-center justify-between gap-3 min-w-0 flex-wrap [&_.settings-note]:[overflow-wrap:anywhere]",
  "access-user-actions": "[&_.ui-button]:m-1 [&_.access-role-assignment]:text-info",
  "access-users-table":
    "[&_th:nth-child(3)]:min-w-16 [&_th:nth-child(3)]:w-[9%] [&_td:nth-child(3)]:min-w-16 [&_th:nth-child(5)]:min-w-[104px] [&_th:nth-child(5)]:w-[18%] [&_td:nth-child(5)]:min-w-[104px] [&_td:nth-child(2)]:whitespace-nowrap [table-layout:fixed] w-full min-w-0 [&_td]:py-3 [&_td]:px-2 [&_td]:[overflow-wrap:anywhere] [&_td]:whitespace-normal [&_th]:py-3 [&_th]:px-2 [&_th]:[overflow-wrap:anywhere] [&_th]:whitespace-normal [&_th:first-child]:w-[26%] [&_th:nth-child(2)]:w-[8%] [&_th:nth-child(4)]:w-[19%] [&_th:last-child]:w-[20%] [&_.table-secondary]:text-xs [&_.access-user-actions]:min-w-0 [&_.access-user-actions_.button]:max-w-full",
  "action-dialog-form": "mt-0",
  "form-context-summary":
    "grid grid-cols-[minmax(0,_1fr)_auto] items-center gap-[4px_12px] py-3 px-3.5 border border-solid border-border rounded-lg bg-muted [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_>_small]:text-muted-foreground [&_>_small]:text-xs [&_>_small]:col-span-full [&_>_strong]:[grid-column:2] [&_>_strong]:[grid-row:1]",
  "management-disclosure":
    "min-w-0 p-3 border border-solid border-border rounded-lg [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:font-semibold [&[data-open=true]_.ui-disclosure-label]:mb-3",
  "permission-list":
    "flex flex-wrap gap-1.5 [&_code]:inline-flex [&_code]:items-center [&_code]:py-1 [&_code]:px-[7px] [&_code]:rounded-md [&_code]:text-muted-foreground [&_code]:bg-muted [&_code]:text-xs",
  "role-action-summary": "w-fit text-muted-foreground cursor-pointer",
  "role-actions": "grid gap-2",
  "role-card":
    "grid [align-content:start] min-w-0 gap-2.5 p-4 border border-solid border-border rounded-lg [overflow-wrap:anywhere] [&_>_div:first-child]:flex [&_>_div:first-child]:flex-wrap [&_>_div:first-child]:items-baseline [&_>_div:first-child]:justify-between [&_>_div:first-child]:gap-3 [&_>_div:first-child_strong]:min-w-0 [&_>_div:first-child_strong]:max-w-full [&_small]:text-muted-foreground [&_p]:text-muted-foreground [&_p]:m-0",
  "role-grid": "grid items-start grid-cols-[repeat(auto-fit,_minmax(260px,_1fr))] gap-3",
  "row-more-actions":
    "[&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:font-semibold mt-2 text-xs [&_.ui-disclosure-body_>_div]:grid [&_.ui-disclosure-body_>_div]:gap-2 [&_.ui-disclosure-body_>_div]:mt-2",
  "settings-directory-actions": "grid gap-2.5 mt-4",
  "settings-form-actions":
    "flex justify-end gap-2.5 [&.management-sticky-actions]:bottom-3 [&.management-sticky-actions]:border [&.management-sticky-actions]:border-solid [&.management-sticky-actions]:border-border [&.management-sticky-actions]:rounded-xl [&.management-sticky-actions]:shadow-xs",
  "settings-form-fieldset":
    "contents min-w-0 m-0 border-0 p-0 [&:disabled]:opacity-78 [&[hidden]]:hidden",
  "settings-user-filter":
    "grid grid-cols-[minmax(220px,_1fr)_minmax(140px,_220px)_auto] items-end gap-3 [margin-block:18px_12px] [&_label]:grid [&_label]:gap-[7px] [&_label]:text-xs [&_label]:font-semibold",
  "stat-list":
    "flex flex-col [margin:20px_0_16px] [&_>_div]:flex [&_>_div]:items-center [&_>_div]:justify-between [&_>_div]:py-[11px] [&_>_div]:px-0 [&_>_div]:border-b [&_>_div]:border-solid [&_>_div]:border-border [&_>_div:last-child]:border-b-0 [&_dt]:flex [&_dt]:items-center [&_dt]:gap-2 [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:text-lg [&_dd]:font-semibold [&_dd]:tabular-nums",
  "table-action": "w-fit border-0 text-destructive bg-transparent cursor-pointer",
} as const;
