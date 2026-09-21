"use client";

import {
  formatPlatformDateTime,
  platformDateTimeInputToIso,
  platformDateTimeInputValue,
} from "@/lib/platform-date-time";

import { Button, CheckboxGroup, DatetimeInput, Input, Select } from "@/components/ui";

import type {
  ApiToken,
  RetentionExecutionResult,
  RetentionPolicy,
  RetentionPreview,
  ServiceAccount,
} from "@autoforge/contracts";
import { permissionCatalog } from "@autoforge/domain";
import { KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ActionDialog } from "@/components/action-dialog";
import {
  permissionDescription,
  permissionLabel,
  permissionGroup,
} from "@/lib/permission-presentation";
import { useConfirm, useToast } from "@/components/ui-feedback";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { copyTextToClipboard } from "@/lib/client-clipboard";
import { throwApiErrorResponse } from "@/lib/client-api";

export function OperationsSettings({
  initialAccounts,
  initialPolicies,
  projects,
  canManageSettings,
  canManageTokens,
  visibleSection,
  accountFilter,
}: {
  initialAccounts: ServiceAccount[];
  accountFilter?: { query: string; status: string };
  initialPolicies: RetentionPolicy[];
  canManageSettings: boolean;
  canManageTokens: boolean;
  projects: Array<{ id: string; name: string }>;
  visibleSection: "accounts" | "retention";
}) {
  const confirmAction = useConfirm();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const toast = useToast();
  const [accounts, setAccounts] = useState(initialAccounts);
  const [policies, setPolicies] = useState(initialPolicies);
  const [tokens, setTokens] = useState<Record<string, ApiToken[]>>({});
  const [issuedToken, setIssuedToken] = useState("");
  const [dirtyPolicies, setDirtyPolicies] = useState<Record<string, boolean>>({});
  const [previews, setPreviews] = useState<Record<string, RetentionPreview>>({});
  const [pending, setPending] = useState(false);
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string>();
  const [issuingAccountId, setIssuingAccountId] = useState<string>();
  const [accountQuery, setAccountQuery] = useState(accountFilter?.query ?? "");
  const [accountStatus, setAccountStatus] = useState(accountFilter?.status ?? "");
  const [formError, setFormError] = useState("");
  const visibleAccounts = accounts;

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await mutate(async () => {
      const account = await requestJson<ServiceAccount>("/api/v1/service-accounts", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          description: form.get("description"),
          systemPermissions: form.getAll("permissions"),
          projectPermissions: projectPermissionsFromForm(form, projects),
        }),
      });
      setAccounts((current) => [...current, account].sort((a, b) => a.name.localeCompare(b.name)));
      formElement.reset();
      setCreateAccountOpen(false);
      return "服务账号已创建。";
    });
  }

  async function issueToken(event: FormEvent<HTMLFormElement>, account: ServiceAccount) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate(async () => {
      const issued = await requestJson<ApiToken & { token: string }>(
        `/api/v1/service-accounts/${encodeURIComponent(account.id)}/tokens`,
        {
          method: "POST",
          body: JSON.stringify({
            name: form.get("name"),
            scopes: form.getAll("scopes"),
            expiresAt: requiredPlatformDateTimeIso(String(form.get("expiresAt"))),
          }),
        },
      );
      setIssuedToken(issued.token);
      setIssuingAccountId(undefined);
      setTokens((current) => ({
        ...current,
        [account.id]: [{ ...issued, token: undefined }, ...(current[account.id] ?? [])],
      }));
      return "API 令牌已签发，只会显示这一次。";
    });
  }

  async function loadTokens(accountId: string) {
    await mutate(async () => {
      const result = await requestJson<{ items: ApiToken[] }>(
        `/api/v1/service-accounts/${encodeURIComponent(accountId)}/tokens`,
      );
      setTokens((current) => ({ ...current, [accountId]: result.items }));
      return "令牌列表已刷新。";
    });
  }

  async function revokeToken(token: ApiToken) {
    if (
      !(await confirmAction({
        title: "撤销 API 令牌",
        description: `令牌“${token.name}”会立即失效，使用它的自动化调用将无法继续。`,
        confirmLabel: "确认撤销",
        tone: "danger",
      }))
    )
      return;
    await mutate(async () => {
      const revoked = await requestJson<ApiToken>(
        `/api/v1/api-tokens/${encodeURIComponent(token.id)}/revoke`,
        { method: "POST" },
      );
      setTokens((current) => ({
        ...current,
        [token.serviceAccountId]: (current[token.serviceAccountId] ?? []).map((item) =>
          item.id === token.id ? revoked : item,
        ),
      }));
      return "API 令牌已撤销。";
    });
  }

  async function updateAccount(event: FormEvent<HTMLFormElement>, account: ServiceAccount) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate(async () => {
      const updated = await requestJson<ServiceAccount>(
        `/api/v1/service-accounts/${encodeURIComponent(account.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: form.get("name"),
            description: form.get("description"),
            systemPermissions: form.getAll("permissions"),
            projectPermissions: projectPermissionsFromForm(form, projects),
            expectedRevision: account.revision,
          }),
        },
      );
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setEditingAccountId(undefined);
      return "服务账号已更新，权限缩减对后续令牌鉴权立即生效。";
    });
  }

  async function toggleAccount(account: ServiceAccount) {
    const status = account.status === "active" ? "disabled" : "active";
    if (
      !(await confirmAction({
        title: status === "disabled" ? "禁用服务账号" : "启用服务账号",
        description:
          status === "disabled"
            ? `服务账号“${account.name}”的全部令牌将立即失效。`
            : `将重新启用服务账号“${account.name}”，已撤销和已过期令牌不会恢复。`,
        confirmLabel: "确认变更",
        tone: status === "disabled" ? "danger" : "default",
      }))
    ) {
      return;
    }
    await mutate(async () => {
      const updated = await requestJson<ServiceAccount>(
        `/api/v1/service-accounts/${encodeURIComponent(account.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status, expectedRevision: account.revision }),
        },
      );
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      return status === "disabled" ? "服务账号已禁用。" : "服务账号已重新启用。";
    });
  }

  async function updateRetention(event: FormEvent<HTMLFormElement>, policy: RetentionPolicy) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate(async () => {
      const updated = await requestJson<RetentionPolicy>(
        `/api/v1/settings/retention/${policy.category}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            retentionDays: Number(form.get("retentionDays")),
            expectedRevision: policy.revision,
          }),
        },
      );
      setPolicies((current) =>
        current.map((item) => (item.category === updated.category ? updated : item)),
      );
      setPreviews((current) => {
        const next = { ...current };
        delete next[policy.category];
        return next;
      });
      setDirtyPolicies((current) => ({ ...current, [policy.category]: false }));
      return "保留策略已更新，请重新预览后清理。";
    });
  }

  async function previewRetention(policy: RetentionPolicy) {
    await mutate(async () => {
      const preview = await requestJson<RetentionPreview>(
        `/api/v1/settings/retention/${policy.category}/preview`,
      );
      setPreviews((current) => ({ ...current, [policy.category]: preview }));
      return "影响预览已刷新。";
    });
  }

  async function executeRetention(policy: RetentionPolicy) {
    const preview = previews[policy.category];
    if (!preview) return;
    if (
      !(await confirmAction({
        title: `清理${retentionLabel(policy.category)}`,
        description: `当前预览为 ${preview.eligibleRecords} 条，删除后的业务记录不可恢复。`,
        confirmLabel: "确认清理",
        tone: "danger",
      }))
    ) {
      return;
    }
    await mutate(async () => {
      const result = await requestJson<RetentionExecutionResult>(
        `/api/v1/settings/retention/${policy.category}/execute`,
        {
          method: "POST",
          body: JSON.stringify({
            confirmation: policy.category,
            limit: 1_000,
            expectedRevision: preview.policyRevision,
            previewCutoffAt: preview.cutoffAt,
          }),
        },
      );
      const refreshed = await requestJson<RetentionPreview>(
        `/api/v1/settings/retention/${policy.category}/preview`,
      );
      setPreviews((current) => ({ ...current, [policy.category]: refreshed }));
      return `清理已完成：删除 ${result.deletedRecords} 条记录，完成 ${result.completedObjectDeletes}/${result.queuedObjectDeletes} 个对象删除。`;
    });
  }

  async function mutate(operation: () => Promise<string>) {
    setPending(true);
    setFormError("");
    try {
      toast.success(await operation());
    } catch (problem) {
      if (await showConcurrentModification(problem)) return;
      const message = problem instanceof Error ? problem.message : "操作失败。";
      if (createAccountOpen || editingAccountId || issuingAccountId) setFormError(message);
      else toast.error(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="settings-stack operations-settings">
      {visibleSection === "accounts" ? (
        <section className="content-card settings-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Automation Identity</p>
              <h2>服务账号与 API 令牌</h2>
            </div>
            {canManageTokens ? (
              <Button
                onClick={() => {
                  setFormError("");
                  setCreateAccountOpen(true);
                }}
                type="button"
                variant="primary"
              >
                <Plus size={16} /> 创建账号
              </Button>
            ) : (
              <KeyRound size={22} />
            )}
          </div>
          <p className="settings-note">
            令牌明文只在签发时显示一次，数据库仅保存 SHA-256 摘要；作用域不能超过服务账号权限。
          </p>
          {issuedToken ? (
            <div className="issued-token" role="status">
              <span>
                <strong>请立即复制并离线保管</strong>
                <code>{issuedToken}</code>
              </span>
              <Button
                className="button button-secondary"
                onClick={() =>
                  void copyTextToClipboard(issuedToken).then(
                    () => toast.success("令牌已复制。"),
                    () => toast.error("复制失败，请手动选择并复制下方令牌。"),
                  )
                }
                type="button"
              >
                复制
              </Button>
            </div>
          ) : null}
          <ActionDialog
            protectUnsavedChanges
            description="服务账号用于 Jenkins 等自动化系统，权限应按最小范围分配。"
            onClose={() => !pending && setCreateAccountOpen(false)}
            open={createAccountOpen}
            title="创建服务账号"
          >
            <form className="settings-grid-form action-dialog-form" onSubmit={createAccount}>
              {formError ? (
                <p className="form-error settings-wide-field" role="alert">
                  {formError}
                </p>
              ) : null}
              <label>
                账号名称
                <Input name="name" required />
              </label>
              <label>
                用途说明
                <Input name="description" />
              </label>
              <PermissionCheckboxGroup label="系统权限" name="permissions" />
              <ProjectPermissionFields projects={projects} />
              <Button className="button button-primary" disabled={pending} type="submit">
                <Plus size={16} /> 创建服务账号
              </Button>
            </form>
          </ActionDialog>
          {!canManageTokens ? (
            <div className="implementation-notice">当前身份没有服务账号管理权限。</div>
          ) : null}
          <form className="management-toolbar" method="get">
            <input type="hidden" name="section" value="accounts" />
            <label>
              搜索账号
              <Input
                name="query"
                onChange={(event) => setAccountQuery(event.target.value)}
                type="search"
                value={accountQuery}
              />
            </label>
            <label>
              账号状态
              <Select
                name="status"
                onChange={(event) => setAccountStatus(event.target.value)}
                value={accountStatus}
              >
                <option value="">全部状态</option>
                <option value="active">启用</option>
                <option value="disabled">禁用</option>
              </Select>
            </label>
            <span>本页 {accounts.length} 个账号</span>
            <Button type="submit">搜索</Button>
          </form>
          <div className="service-account-list">
            {visibleAccounts.length === 0 ? (
              <div className="inline-empty">没有匹配的服务账号。可调整筛选或创建账号。</div>
            ) : (
              visibleAccounts.map((account) => (
                <article key={account.id}>
                  <div className="service-account-heading">
                    <span>
                      <strong>{account.name}</strong>
                      <small>
                        {account.description || "无说明"} ·{" "}
                        {account.status === "active" ? "启用" : "禁用"}
                      </small>
                    </span>
                    <Button
                      className="button button-secondary compact-button"
                      disabled={pending}
                      onClick={() => void loadTokens(account.id)}
                      type="button"
                    >
                      <RefreshCw size={14} /> 令牌
                    </Button>
                  </div>
                  <p className="settings-note">
                    系统权限 {account.systemPermissions.length} 项 · 项目授权{" "}
                    {Object.keys(account.projectPermissions).length} 个：
                    {Object.keys(account.projectPermissions)
                      .map((id) => projects.find((project) => project.id === id)?.name ?? id)
                      .join("、") || "无"}
                  </p>
                  <details className="account-permission-summary">
                    <summary>查看权限摘要</summary>
                    <div className="permission-chip-row">
                      {account.systemPermissions.map((permission) => (
                        <span
                          className="permission-chip"
                          key={permission}
                          title={permissionDescription(permission)}
                        >
                          {permissionLabel(permission)}
                        </span>
                      ))}
                    </div>
                  </details>
                  {canManageTokens ? (
                    <div className="button-row">
                      <Button
                        onClick={() => {
                          setFormError("");
                          setEditingAccountId(account.id);
                        }}
                        type="button"
                      >
                        编辑账号与权限
                      </Button>
                      {account.status === "active" ? (
                        <Button
                          onClick={() => {
                            setFormError("");
                            setIssuingAccountId(account.id);
                          }}
                          type="button"
                          variant="secondary"
                        >
                          签发令牌
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {canManageTokens && editingAccountId === account.id ? (
                    <ActionDialog
                      protectUnsavedChanges
                      title={`编辑服务账号：${account.name}`}
                      open
                      onClose={() => !pending && setEditingAccountId(undefined)}
                    >
                      <form
                        className="settings-grid-form settings-subform"
                        onSubmit={(event) => void updateAccount(event, account)}
                      >
                        {formError ? (
                          <p className="form-error settings-wide-field" role="alert">
                            {formError}
                          </p>
                        ) : null}
                        <label>
                          账号名称
                          <Input defaultValue={account.name} name="name" required />
                        </label>
                        <label>
                          用途说明
                          <Input defaultValue={account.description} name="description" />
                        </label>
                        <PermissionCheckboxGroup
                          defaultValue={account.systemPermissions}
                          label="系统权限"
                          name="permissions"
                        />
                        <ProjectPermissionFields
                          initialPermissions={account.projectPermissions}
                          projects={projects}
                        />
                        <p className="settings-note settings-wide-field">
                          移除权限后，现有令牌不会重新显示或扩大作用域；后续鉴权会立即按账号与令牌作用域交集收紧。
                        </p>
                        <span className="settings-form-actions">
                          <Button
                            className="button button-primary"
                            disabled={pending}
                            type="submit"
                          >
                            保存账号
                          </Button>
                          <Button
                            className={
                              account.status === "active"
                                ? "button button-danger-quiet"
                                : "button button-secondary"
                            }
                            disabled={pending}
                            onClick={() => void toggleAccount(account)}
                            type="button"
                          >
                            {account.status === "active" ? "禁用账号" : "启用账号"}
                          </Button>
                        </span>
                      </form>
                    </ActionDialog>
                  ) : null}
                  {canManageTokens && issuingAccountId === account.id ? (
                    <ActionDialog
                      protectUnsavedChanges
                      title={`签发令牌：${account.name}`}
                      open
                      onClose={() => !pending && setIssuingAccountId(undefined)}
                    >
                      <form
                        className="settings-grid-form action-dialog-form"
                        onSubmit={(event) => void issueToken(event, account)}
                      >
                        {formError ? (
                          <p className="form-error settings-wide-field" role="alert">
                            {formError}
                          </p>
                        ) : null}
                        <label>
                          令牌名称
                          <Input name="name" required />
                        </label>
                        <label>
                          过期时间
                          <DatetimeInput
                            min={platformDateTimeInputValue(new Date())}
                            name="expiresAt"
                            required
                          />
                        </label>
                        <CheckboxGroup
                          label="作用域"
                          name="scopes"
                          options={[
                            ...new Set([
                              ...account.systemPermissions,
                              ...Object.values(account.projectPermissions).flat(),
                            ]),
                          ].map((scope) => ({
                            value: scope,
                            label: permissionLabel(scope),
                            group: permissionGroup(scope),
                            description: permissionDescription(scope),
                          }))}
                          required
                        />
                        <Button className="button button-primary" disabled={pending} type="submit">
                          签发
                        </Button>
                      </form>
                    </ActionDialog>
                  ) : null}
                  {(tokens[account.id] ?? []).map((token) => (
                    <div className="token-row" key={token.id}>
                      <span>
                        <code>{token.prefix}…</code>
                        <small>
                          {token.name} · 至 {formatDate(token.expiresAt)}
                        </small>
                      </span>
                      <span>
                        {token.revokedAt
                          ? "已撤销"
                          : account.status === "disabled"
                            ? "已随账号禁用失效"
                            : Date.parse(token.expiresAt) <= Date.now()
                              ? "已过期"
                              : token.lastUsedAt
                                ? `最近使用 ${formatDate(token.lastUsedAt)}`
                                : "从未使用"}
                      </span>
                      {!token.revokedAt && canManageTokens && account.status === "active" ? (
                        <Button
                          aria-label={`撤销 ${token.name}`}
                          onClick={() => void revokeToken(token)}
                          type="button"
                        >
                          <Trash2 size={15} />
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </article>
              ))
            )}
          </div>
        </section>
      ) : null}

      {visibleSection === "retention" ? (
        <section className="content-card settings-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Data Governance</p>
              <h2>保留与清理策略</h2>
            </div>
            <ShieldCheck size={22} />
          </div>
          <p className="settings-note">
            每类数据独立配置。预览只统计已满足终态和安全删除条件的记录；对象删除由可重试清理路径处理。
          </p>
          <div className="retention-policy-grid">
            {policies.map((policy) => (
              <form key={policy.category} onSubmit={(event) => void updateRetention(event, policy)}>
                <strong>{retentionLabel(policy.category)}</strong>
                <small>
                  允许 {policy.minimumDays}–{policy.maximumDays} 天
                </small>
                <label>
                  保留天数
                  <Input
                    onChange={() => {
                      setDirtyPolicies((current) => ({ ...current, [policy.category]: true }));
                      setPreviews((current) => {
                        const next = { ...current };
                        delete next[policy.category];
                        return next;
                      });
                    }}
                    defaultValue={policy.retentionDays}
                    disabled={!canManageSettings}
                    max={policy.maximumDays}
                    min={policy.minimumDays}
                    name="retentionDays"
                    type="number"
                  />
                </label>
                {dirtyPolicies[policy.category] ? (
                  <p className="settings-note">有未保存的修改，请先保存再预览。</p>
                ) : null}
                {previews[policy.category] ? (
                  <p>
                    当前将影响 {previews[policy.category]?.eligibleRecords} 条 /{" "}
                    {formatBytes(previews[policy.category]?.eligibleBytes ?? 0)}
                    <small>
                      策略版本 {previews[policy.category]?.policyRevision} · 预览于{" "}
                      {formatPlatformDateTime(previews[policy.category]?.generatedAt ?? "")}
                    </small>
                  </p>
                ) : null}
                <span>
                  <Button
                    className="button button-secondary compact-button"
                    disabled={pending || dirtyPolicies[policy.category]}
                    onClick={() => void previewRetention(policy)}
                    type="button"
                  >
                    影响预览
                  </Button>
                  {canManageSettings ? (
                    <>
                      <Button
                        className="button button-primary compact-button"
                        disabled={pending}
                        type="submit"
                      >
                        保存
                      </Button>
                      <Button
                        className="button button-danger-quiet compact-button"
                        disabled={pending || !previews[policy.category]}
                        onClick={() => void executeRetention(policy)}
                        type="button"
                      >
                        执行清理
                      </Button>
                    </>
                  ) : null}
                </span>
              </form>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ProjectPermissionFields({
  projects,
  initialPermissions = {},
}: {
  projects: Array<{ id: string; name: string }>;
  initialPermissions?: ServiceAccount["projectPermissions"];
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(
    Object.keys(initialPermissions)[0] ?? projects[0]?.id ?? "",
  );
  const [permissions, setPermissions] = useState(initialPermissions);
  if (projects.length === 0) return null;
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  return (
    <fieldset className="settings-wide-field settings-fieldset">
      <legend>项目作用域权限</legend>
      <label>
        配置授权项目
        <Select
          value={selectedProjectId}
          onChange={(event) => setSelectedProjectId(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} · 已选 {permissions[project.id]?.length ?? 0} 项
            </option>
          ))}
        </Select>
      </label>
      <p className="settings-note">
        仅影响选定项目；切换项目会保留其他项目的已选权限。全选只作用于当前权限组。
      </p>
      {Object.entries(permissions)
        .filter(([id]) => id !== selectedProjectId)
        .flatMap(([id, values]) =>
          values.map((value) => (
            <input
              key={`${id}:${value}`}
              name={`projectPermissions:${id}`}
              type="hidden"
              value={value}
            />
          )),
        )}
      {selectedProject ? (
        <PermissionCheckboxGroup
          key={selectedProjectId}
          className="project-permission-group"
          label={selectedProject.name}
          name={`projectPermissions:${selectedProjectId}`}
          defaultValue={permissions[selectedProjectId] ?? []}
          onSelectionChange={(values) =>
            setPermissions((current) => ({ ...current, [selectedProjectId]: values }))
          }
        />
      ) : null}
    </fieldset>
  );
}

function PermissionCheckboxGroup({
  className,
  defaultValue,
  label,
  name,
  required,
  onSelectionChange,
}: {
  className?: string;
  defaultValue?: readonly string[];
  label: string;
  name: string;
  required?: boolean;
  onSelectionChange?: (values: string[]) => void;
}) {
  return (
    <CheckboxGroup
      className={`settings-wide-field${className ? ` ${className}` : ""}`}
      {...(defaultValue ? { defaultValue } : {})}
      {...(onSelectionChange ? { onSelectionChange } : {})}
      label={label}
      name={name}
      options={permissionCatalog.map((permission) => ({
        value: permission,
        label: permissionLabel(permission),
        group: permissionGroup(permission),
        description: permissionDescription(permission),
      }))}
      {...(required !== undefined ? { required } : {})}
    />
  );
}

function projectPermissionsFromForm(
  form: FormData,
  projects: Array<{ id: string; name: string }>,
): Record<string, string[]> {
  return Object.fromEntries(
    projects
      .map(
        (project) =>
          [project.id, form.getAll(`projectPermissions:${project.id}`).map(String)] as const,
      )
      .filter(([, permissions]) => permissions.length > 0),
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  if (!response.ok) await throwApiErrorResponse(response, "请求失败。");
  return (await response.json()) as T;
}

function retentionLabel(category: RetentionPolicy["category"]): string {
  return {
    execution: "执行数据",
    log: "日志",
    artifact: "产物",
    source: "来源 JAR",
    analytics: "分析事实",
    audit: "审计",
    session: "会话",
    queue: "队列与死信",
  }[category];
}
function formatDate(value: string): string {
  return formatPlatformDateTime(value, undefined, { dateStyle: "medium", timeStyle: "short" });
}

function requiredPlatformDateTimeIso(value: string): string {
  const iso = platformDateTimeInputToIso(value);
  if (!iso) throw new Error("过期时间无效，请按平台时区重新选择。");
  return iso;
}
function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1_048_576
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1_048_576).toFixed(1)} MiB`;
}
