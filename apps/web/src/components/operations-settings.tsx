"use client";

import { Button, DatetimeInput, Input, Select } from "@/components/ui";

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

export function OperationsSettings({
  initialAccounts,
  initialPolicies,
  projects,
  canManageSettings,
  canManageTokens,
  visibleSection,
}: {
  initialAccounts: ServiceAccount[];
  initialPolicies: RetentionPolicy[];
  canManageSettings: boolean;
  canManageTokens: boolean;
  projects: Array<{ id: string; name: string }>;
  visibleSection: "accounts" | "retention";
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [policies, setPolicies] = useState(initialPolicies);
  const [tokens, setTokens] = useState<Record<string, ApiToken[]>>({});
  const [issuedToken, setIssuedToken] = useState("");
  const [previews, setPreviews] = useState<Record<string, RetentionPreview>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [createAccountOpen, setCreateAccountOpen] = useState(false);

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
            expiresAt: new Date(String(form.get("expiresAt"))).toISOString(),
          }),
        },
      );
      setIssuedToken(issued.token);
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
    if (!window.confirm(`撤销令牌 ${token.name}？自动化调用会立即失效。`)) return;
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
      return "服务账号已更新，权限缩减对后续令牌鉴权立即生效。";
    });
  }

  async function toggleAccount(account: ServiceAccount) {
    const status = account.status === "active" ? "disabled" : "active";
    if (
      !window.confirm(
        status === "disabled"
          ? `禁用服务账号 ${account.name}？其全部令牌将立即失效。`
          : `重新启用服务账号 ${account.name}？已撤销和已过期令牌不会恢复。`,
      )
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
      return "保留策略已更新。";
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
      !window.confirm(
        `立即清理 ${retentionLabel(policy.category)}？当前预览为 ${preview.eligibleRecords} 条，删除后的业务记录不可恢复。`,
      )
    ) {
      return;
    }
    await mutate(async () => {
      const result = await requestJson<RetentionExecutionResult>(
        `/api/v1/settings/retention/${policy.category}/execute`,
        {
          method: "POST",
          body: JSON.stringify({ confirmation: policy.category, limit: 1_000 }),
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
    setError("");
    setMessage("");
    try {
      setMessage(await operation());
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "操作失败。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="settings-stack operations-settings">
      {message ? <div className="inline-success">{message}</div> : null}
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}

      {visibleSection === "accounts" ? (
        <section className="content-card settings-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Automation Identity</p>
              <h2>服务账号与 API 令牌</h2>
            </div>
            {canManageTokens ? (
              <Button onClick={() => setCreateAccountOpen(true)} type="button" variant="primary">
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
                onClick={() => void navigator.clipboard.writeText(issuedToken)}
                type="button"
              >
                复制
              </Button>
            </div>
          ) : null}
          <ActionDialog
            description="服务账号用于 Jenkins 等自动化系统，权限应按最小范围分配。"
            onClose={() => !pending && setCreateAccountOpen(false)}
            open={createAccountOpen}
            title="创建服务账号"
          >
            <form className="settings-grid-form action-dialog-form" onSubmit={createAccount}>
              <label>
                账号名称
                <Input name="name" required />
              </label>
              <label>
                用途说明
                <Input name="description" />
              </label>
              <label className="settings-wide-field">
                系统权限
                <Select multiple name="permissions" required size={6}>
                  {permissionCatalog.map((permission) => (
                    <option key={permission}>{permission}</option>
                  ))}
                </Select>
              </label>
              <ProjectPermissionFields projects={projects} />
              <Button className="button button-primary" disabled={pending} type="submit">
                <Plus size={16} /> 创建服务账号
              </Button>
            </form>
          </ActionDialog>
          {!canManageTokens ? (
            <div className="implementation-notice">当前身份没有服务账号管理权限。</div>
          ) : null}
          <div className="service-account-list">
            {accounts.length === 0 ? (
              <div className="inline-empty">尚未创建服务账号。</div>
            ) : (
              accounts.map((account) => (
                <article key={account.id}>
                  <div className="service-account-heading">
                    <span>
                      <strong>{account.name}</strong>
                      <small>
                        {account.description || "无说明"} · {account.status}
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
                  <div className="permission-chip-row">
                    {account.systemPermissions.map((permission) => (
                      <code key={permission}>{permission}</code>
                    ))}
                  </div>
                  {canManageTokens ? (
                    <details className="service-account-editor">
                      <summary>编辑账号与权限</summary>
                      <form
                        className="settings-grid-form settings-subform"
                        onSubmit={(event) => void updateAccount(event, account)}
                      >
                        <label>
                          账号名称
                          <Input defaultValue={account.name} name="name" required />
                        </label>
                        <label>
                          用途说明
                          <Input defaultValue={account.description} name="description" />
                        </label>
                        <label className="settings-wide-field">
                          系统权限
                          <Select
                            defaultValue={account.systemPermissions}
                            multiple
                            name="permissions"
                            size={6}
                          >
                            {permissionCatalog.map((permission) => (
                              <option key={permission}>{permission}</option>
                            ))}
                          </Select>
                        </label>
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
                    </details>
                  ) : null}
                  {canManageTokens && account.status === "active" ? (
                    <form
                      className="token-issue-form"
                      onSubmit={(event) => void issueToken(event, account)}
                    >
                      <label>
                        令牌名称
                        <Input name="name" required />
                      </label>
                      <label>
                        过期时间
                        <DatetimeInput
                          min={new Date().toISOString().slice(0, 16)}
                          name="expiresAt"
                          required
                        />
                      </label>
                      <label>
                        作用域
                        <Select multiple name="scopes" required size={4}>
                          {[
                            ...new Set([
                              ...account.systemPermissions,
                              ...Object.values(account.projectPermissions).flat(),
                            ]),
                          ].map((scope) => (
                            <option key={scope}>{scope}</option>
                          ))}
                        </Select>
                      </label>
                      <Button className="button button-primary" disabled={pending} type="submit">
                        签发
                      </Button>
                    </form>
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
                    defaultValue={policy.retentionDays}
                    disabled={!canManageSettings}
                    max={policy.maximumDays}
                    min={policy.minimumDays}
                    name="retentionDays"
                    type="number"
                  />
                </label>
                {previews[policy.category] ? (
                  <p>
                    当前将影响 {previews[policy.category]?.eligibleRecords} 条 /{" "}
                    {formatBytes(previews[policy.category]?.eligibleBytes ?? 0)}
                  </p>
                ) : null}
                <span>
                  <Button
                    className="button button-secondary compact-button"
                    disabled={pending}
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
  if (projects.length === 0) return null;
  return (
    <fieldset className="settings-wide-field settings-fieldset">
      <legend>项目作用域权限</legend>
      <div className="settings-paired-forms">
        {projects.map((project) => (
          <label key={project.id}>
            {project.name}
            <Select
              defaultValue={initialPermissions[project.id] ?? []}
              multiple
              name={`projectPermissions:${project.id}`}
              size={5}
            >
              {permissionCatalog.map((permission) => (
                <option key={permission}>{permission}</option>
              ))}
            </Select>
            <small>{project.id}</small>
          </label>
        ))}
      </div>
    </fieldset>
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
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "请求失败。");
  return body;
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
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1_048_576
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1_048_576).toFixed(1)} MiB`;
}
