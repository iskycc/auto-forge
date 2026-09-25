"use client";
import { EmptyState } from "@/components/ui/empty-state";

import { Badge } from "@/components/ui/badge";

import { Notice } from "@/components/ui/notice";

import { Disclosure } from "@/components/ui/disclosure";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

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
    <div
      className={cn(
        "settings-stack operations-settings",
        uiPatterns["settings-stack"],
        operationsSettingsStyles["operations-settings"],
      )}
    >
      {visibleSection === "accounts" ? (
        <Card
          as="section"
          className={cn(
            "content-card settings-section",
            uiPatterns["content-card"],
            uiPatterns["settings-section"],
          )}
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <h2>账号与令牌</h2>
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
          <p className={cn("settings-note", uiPatterns["settings-note"])}>
            令牌仅在签发时显示一次；可用权限不能超过所属服务账号。
          </p>
          {issuedToken ? (
            <div
              className={cn("issued-token", operationsSettingsStyles["issued-token"])}
              role="status"
            >
              <span>
                <strong>请立即复制并离线保管</strong>
                <code>{issuedToken}</code>
              </span>
              <Button
                className={cn(
                  "button button-secondary",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                )}
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
            closeDisabled={pending}
            footer={
              <>
                <Button
                  type="button"
                  data-dialog-dismiss
                  onClick={() => setCreateAccountOpen(false)}
                  disabled={pending}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  form="service-account-create"
                  type="submit"
                  disabled={pending}
                >
                  <Plus size={16} /> 创建服务账号
                </Button>
              </>
            }
          >
            <form
              id="service-account-create"
              className={cn(
                "settings-grid-form action-dialog-form",
                uiPatterns["settings-grid-form"],
                operationsSettingsStyles["action-dialog-form"],
              )}
              onSubmit={createAccount}
            >
              {formError ? (
                <Notice
                  tone="error"
                  className={cn(
                    "form-error settings-wide-field",
                    uiPatterns["form-error"],
                    uiPatterns["settings-wide-field"],
                  )}
                  role="alert"
                >
                  {formError}
                </Notice>
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
            </form>
          </ActionDialog>
          {!canManageTokens ? (
            <Notice
              tone="info"
              className={cn(
                "implementation-notice",
                operationsSettingsStyles["implementation-notice"],
              )}
            >
              当前身份没有服务账号管理权限。
            </Notice>
          ) : null}
          <form className={cn("management-toolbar", uiPatterns["management-toolbar"])} method="get">
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
          <div
            className={cn("service-account-list", operationsSettingsStyles["service-account-list"])}
          >
            {visibleAccounts.length === 0 ? (
              <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
                没有匹配的服务账号。可调整筛选或创建账号。
              </EmptyState>
            ) : (
              visibleAccounts.map((account) => (
                <article key={account.id}>
                  <div
                    className={cn(
                      "service-account-heading",
                      operationsSettingsStyles["service-account-heading"],
                    )}
                  >
                    <span>
                      <strong>{account.name}</strong>
                      <small>
                        {account.description || "无说明"} ·{" "}
                        {account.status === "active" ? "启用" : "禁用"}
                      </small>
                    </span>
                    <Button
                      className={cn(
                        "button button-secondary compact-button",
                        uiPatterns["button"],
                        uiPatterns["button-secondary"],
                        uiPatterns["compact-button"],
                      )}
                      disabled={pending}
                      onClick={() => void loadTokens(account.id)}
                      type="button"
                    >
                      <RefreshCw size={14} /> 令牌
                    </Button>
                  </div>
                  <p className={cn("settings-note", uiPatterns["settings-note"])}>
                    系统权限 {account.systemPermissions.length} 项 · 项目授权{" "}
                    {Object.keys(account.projectPermissions).length} 个：
                    {Object.keys(account.projectPermissions)
                      .map((id) => projects.find((project) => project.id === id)?.name ?? id)
                      .join("、") || "无"}
                  </p>
                  <Disclosure
                    header={<>查看权限摘要</>}
                    className={cn(
                      "account-permission-summary",
                      operationsSettingsStyles["account-permission-summary"],
                    )}
                  >
                    <div
                      className={cn(
                        "permission-chip-row",
                        operationsSettingsStyles["permission-chip-row"],
                      )}
                    >
                      {account.systemPermissions.map((permission) => (
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
                  {canManageTokens ? (
                    <div className={cn("button-row", uiPatterns["button-row"])}>
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
                      closeDisabled={pending}
                      footer={
                        <>
                          <Button
                            className={cn(
                              "button button-primary",
                              uiPatterns["button"],
                              uiPatterns["button-primary"],
                            )}
                            disabled={pending}
                            type="submit"
                            form={`edit-service-account-${account.id}`}
                          >
                            保存账号
                          </Button>
                          <Button
                            className={
                              account.status === "active"
                                ? cn(
                                    "button button-danger-quiet",
                                    uiPatterns["button"],
                                    uiPatterns["button-danger-quiet"],
                                  )
                                : cn(
                                    "button button-secondary",
                                    uiPatterns["button"],
                                    uiPatterns["button-secondary"],
                                  )
                            }
                            disabled={pending}
                            onClick={() => void toggleAccount(account)}
                            type="button"
                          >
                            {account.status === "active" ? "禁用账号" : "启用账号"}
                          </Button>
                        </>
                      }
                      open
                      onClose={() => !pending && setEditingAccountId(undefined)}
                    >
                      <form
                        id={`edit-service-account-${account.id}`}
                        className={cn(
                          "settings-grid-form settings-subform",
                          uiPatterns["settings-grid-form"],
                          uiPatterns["settings-subform"],
                        )}
                        onSubmit={(event) => void updateAccount(event, account)}
                      >
                        {formError ? (
                          <Notice
                            tone="error"
                            className={cn(
                              "form-error settings-wide-field",
                              uiPatterns["form-error"],
                              uiPatterns["settings-wide-field"],
                            )}
                            role="alert"
                          >
                            {formError}
                          </Notice>
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
                        <p
                          className={cn(
                            "settings-note settings-wide-field",
                            uiPatterns["settings-note"],
                            uiPatterns["settings-wide-field"],
                          )}
                        >
                          移除权限后，现有令牌不会重新显示或扩大作用域；后续鉴权会立即按账号与令牌作用域交集收紧。
                        </p>
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
                        className={cn(
                          "settings-grid-form action-dialog-form",
                          uiPatterns["settings-grid-form"],
                          operationsSettingsStyles["action-dialog-form"],
                        )}
                        onSubmit={(event) => void issueToken(event, account)}
                      >
                        {formError ? (
                          <Notice
                            tone="error"
                            className={cn(
                              "form-error settings-wide-field",
                              uiPatterns["form-error"],
                              uiPatterns["settings-wide-field"],
                            )}
                            role="alert"
                          >
                            {formError}
                          </Notice>
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
                        <Button
                          className={cn(
                            "button button-primary",
                            uiPatterns["button"],
                            uiPatterns["button-primary"],
                          )}
                          disabled={pending}
                          type="submit"
                        >
                          签发
                        </Button>
                      </form>
                    </ActionDialog>
                  ) : null}
                  {(tokens[account.id] ?? []).map((token) => (
                    <div
                      className={cn("token-row", operationsSettingsStyles["token-row"])}
                      key={token.id}
                    >
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
        </Card>
      ) : null}

      {visibleSection === "retention" ? (
        <Card
          as="section"
          className={cn(
            "content-card settings-section",
            uiPatterns["content-card"],
            uiPatterns["settings-section"],
          )}
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Data Governance</p>
              <h2>保留与清理策略</h2>
            </div>
            <ShieldCheck size={22} />
          </div>
          <p className={cn("settings-note", uiPatterns["settings-note"])}>
            每类数据独立配置。预览只统计已满足终态和安全删除条件的记录；对象删除由可重试清理路径处理。
          </p>
          <div
            className={cn(
              "retention-policy-grid",
              operationsSettingsStyles["retention-policy-grid"],
            )}
          >
            {policies.map((policy) => (
              <form key={policy.category} onSubmit={(event) => void updateRetention(event, policy)}>
                <div>
                  <strong>{retentionLabel(policy.category)}</strong>
                  <small>
                    已保存 {policy.retentionDays} 天 · 允许 {policy.minimumDays}–
                    {policy.maximumDays} 天
                  </small>
                </div>
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
                  <p className={cn("settings-note", uiPatterns["settings-note"])}>
                    有未保存的修改，请先保存再预览。
                  </p>
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
                    className={cn(
                      "button button-secondary compact-button",
                      uiPatterns["button"],
                      uiPatterns["button-secondary"],
                      uiPatterns["compact-button"],
                    )}
                    disabled={pending || dirtyPolicies[policy.category]}
                    onClick={() => void previewRetention(policy)}
                    type="button"
                  >
                    影响预览
                  </Button>
                  {canManageSettings ? (
                    <>
                      <Button
                        className={cn(
                          uiPatterns["button"],
                          uiPatterns["compact-button"],
                          `button ${dirtyPolicies[policy.category] ? cn("button-primary", uiPatterns["button-primary"]) : cn("button-secondary", uiPatterns["button-secondary"])} compact-button`,
                        )}
                        disabled={pending || !dirtyPolicies[policy.category]}
                        type="submit"
                      >
                        保存
                      </Button>
                      <Button
                        className={cn(
                          "button button-danger-quiet compact-button",
                          uiPatterns["button"],
                          uiPatterns["button-danger-quiet"],
                          uiPatterns["compact-button"],
                        )}
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
        </Card>
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
    <fieldset
      className={cn(
        "settings-wide-field settings-fieldset",
        uiPatterns["settings-wide-field"],
        operationsSettingsStyles["settings-fieldset"],
      )}
    >
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
      <p className={cn("settings-note", uiPatterns["settings-note"])}>
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
          className={cn(
            "project-permission-group",
            operationsSettingsStyles["project-permission-group"],
          )}
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
      className={cn(
        uiPatterns["settings-wide-field"],
        `settings-wide-field${className ? ` ${className}` : ""}`,
      )}
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

const operationsSettingsStyles = {
  "account-permission-summary":
    "text-muted-foreground text-xs [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:py-2 [&_.ui-disclosure-label]:px-0",
  "action-dialog-form": "mt-0",
  "implementation-notice":
    "mt-4 rounded-lg bg-warning/10 text-warning py-[11px] px-3 text-xs leading-[1.5]",
  "issued-token":
    "flex items-center justify-between gap-4 [margin:12px_0_18px] p-3.5 border border-solid border-transparent rounded-lg bg-warning/10 [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-[7px] [&_code]:overflow-auto [&_code]:p-2 [&_code]:rounded-md [&_code]:bg-card [&_code]:whitespace-nowrap",
  "operations-settings": "mt-4",
  "permission-chip-row":
    "flex flex-wrap gap-1.5 mt-2.5 [&_code]:py-[3px] [&_code]:px-1.5 [&_code]:rounded-md [&_code]:bg-info/10 [&_code]:text-info [&_code]:text-xs [&_.permission-chip]:py-[3px] [&_.permission-chip]:px-1.5 [&_.permission-chip]:rounded-md [&_.permission-chip]:bg-info/10 [&_.permission-chip]:text-info [&_.permission-chip]:text-xs",
  "project-permission-group":
    "p-2.5 border border-solid border-border rounded-lg bg-card [&_.ui-checkbox-group-options]:grid-cols-2 [&_.ui-checkbox-group-options]:max-h-none [&_.ui-checkbox-group-options]:border-0 [&_.ui-checkbox-group-options]:p-0",
  "retention-policy-grid":
    "grid grid-cols-[minmax(0,_1fr)] gap-2 [&_form]:grid [&_form]:gap-3 [&_form]:p-3 [&_form]:border [&_form]:border-solid [&_form]:border-border [&_form]:rounded-lg [&_form]:bg-muted [&_form]:grid-cols-[minmax(0,_1fr)_minmax(100px,_0.6fr)_auto] [&_form]:items-center [&_form_>_small]:m-0 [&_form_>_small]:text-muted-foreground [&_form_>_small]:text-xs [&_form_>_p]:m-0 [&_form_>_p]:text-muted-foreground [&_form_>_p]:text-xs [&_form_>_p]:col-span-full [&_form_>_p]:[grid-row:2] [&_label]:grid [&_label]:gap-[5px] [&_label]:text-xs [&_form_>_span]:flex [&_form_>_span]:flex-wrap [&_form_>_span]:gap-[7px] [&_form_>_span]:[grid-column:3] [&_form_>_span]:[grid-row:1] [&_form_>_div_small]:block [&_form_>_div_small]:mt-1 [&_form_>_div_small]:text-muted-foreground",
  "service-account-heading":
    "flex min-w-0 items-start justify-between gap-3 [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:flex-1 [&_>_span]:gap-1 [&_strong]:[overflow-wrap:anywhere] [&_small]:[overflow-wrap:anywhere] [&_small]:text-muted-foreground [&_small]:text-xs [&_>_button]:shrink-0",
  "service-account-list":
    "grid gap-3 mt-4.5 [&_>_article]:p-4 [&_>_article]:border [&_>_article]:border-solid [&_>_article]:border-border [&_>_article]:rounded-xl [&_>_article]:bg-muted [&_>_article]:min-w-0 [&_.button-row]:justify-end",
  "settings-fieldset":
    "min-w-0 m-0 border border-solid border-border rounded-lg p-3.5 [&_legend]:py-0 [&_legend]:px-1.5 [&_legend]:text-muted-foreground [&_legend]:text-sm [&_legend]:font-semibold",
  "token-row":
    "flex min-w-0 items-center justify-between gap-3 mt-3 pt-3 border-t border-solid border-border [&_>_span:first-child]:grid [&_>_span:first-child]:min-w-0 [&_>_span:first-child]:flex-1 [&_>_span:first-child]:gap-1 [&_small]:[overflow-wrap:anywhere] [&_small]:text-muted-foreground [&_small]:text-xs [&_>_span:nth-child(2)]:shrink-0 [&_>_span:nth-child(2)]:text-muted-foreground [&_>_span:nth-child(2)]:text-xs [&_button]:grid [&_button]:shrink-0 [&_button]:w-8.5 [&_button]:min-h-8.5 [&_button]:place-items-center [&_button]:border-0 [&_button]:rounded-md [&_button]:bg-destructive/10 [&_button]:text-destructive [&_button]:cursor-pointer",
} as const;
