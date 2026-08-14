"use client";

import { Button, Input, Select, Textarea } from "@/components/ui";

import {
  DEFAULT_PROJECT_ID,
  type ExecutionEnvironment,
  type ExecutionEnvironmentDetails,
  type ExecutionEnvironmentReference,
  type ExecutionEnvironmentVersion,
  type ExecutionSecret,
} from "@autoforge/domain";
import { Copy, Plus, Power, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type ProjectOption = { id: string; name: string };
type BindingRow = { id: number; name: string; secretId: string };
type EnvironmentData = {
  details: ExecutionEnvironmentDetails | null;
  versions: ExecutionEnvironmentVersion[];
  references: { items: ExecutionEnvironmentReference[]; total: number };
  metadataName: string;
  metadataDescription: string;
  variableDraft: string;
  bindingRows: BindingRow[];
  nextBindingId: number;
  copyName: string;
};

function initialProjectId(projects: ProjectOption[]): string {
  return projects.some((project) => project.id === DEFAULT_PROJECT_ID)
    ? DEFAULT_PROJECT_ID
    : (projects[0]?.id ?? "");
}

export function EnvironmentSettings({
  activeView,
  initialEnvironments,
  initialSecrets,
  manageableProjectIds,
  projects,
  secretProjectIds,
}: {
  activeView: "environments" | "secrets";
  initialEnvironments: ExecutionEnvironment[];
  initialSecrets: ExecutionSecret[];
  manageableProjectIds: string[] | null;
  projects: ProjectOption[];
  secretProjectIds: string[] | null;
}) {
  const [environments, setEnvironments] = useState(initialEnvironments);
  const [secrets, setSecrets] = useState(initialSecrets);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(
    initialEnvironments[0]?.id ?? "",
  );
  const [details, setDetails] = useState<ExecutionEnvironmentDetails | null>(null);
  const [versions, setVersions] = useState<ExecutionEnvironmentVersion[]>([]);
  const [references, setReferences] = useState<{
    items: ExecutionEnvironmentReference[];
    total: number;
  }>({ items: [], total: 0 });
  const [metadataName, setMetadataName] = useState("");
  const [metadataDescription, setMetadataDescription] = useState("");
  const [variableDraft, setVariableDraft] = useState("");
  const [bindingRows, setBindingRows] = useState<BindingRow[]>([]);
  const [nextBindingId, setNextBindingId] = useState(1);
  const [copyName, setCopyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedSecretId, setSelectedSecretId] = useState(initialSecrets[0]?.id ?? "");

  const loadEnvironment = useCallback(async (environmentId: string): Promise<EnvironmentData> => {
    if (!environmentId) {
      return {
        details: null,
        versions: [],
        references: { items: [], total: 0 },
        metadataName: "",
        metadataDescription: "",
        variableDraft: "",
        bindingRows: [],
        nextBindingId: 1,
        copyName: "",
      };
    }
    const [environment, versionPage, referencePage] = await Promise.all([
      requestJson<ExecutionEnvironmentDetails>(
        `/api/v1/execution-environments/${encodeURIComponent(environmentId)}`,
      ),
      requestJson<{ items: ExecutionEnvironmentVersion[] }>(
        `/api/v1/execution-environments/${encodeURIComponent(environmentId)}/versions`,
      ),
      requestJson<{ items: ExecutionEnvironmentReference[]; total: number }>(
        `/api/v1/execution-environments/${encodeURIComponent(environmentId)}/references?limit=100`,
      ),
    ]);
    return {
      details: environment,
      versions: versionPage.items,
      references: referencePage,
      metadataName: environment.name,
      metadataDescription: environment.description,
      variableDraft: formatVariables(environment.current.variables),
      bindingRows: environment.current.secretBindings.map((binding, index) => ({
        id: index + 1,
        name: binding.name,
        secretId: binding.secretId,
      })),
      nextBindingId: environment.current.secretBindings.length + 1,
      copyName: `${environment.name} 副本`,
    };
  }, []);

  const applyEnvironmentData = useCallback((data: EnvironmentData): void => {
    setDetails(data.details);
    setVersions(data.versions);
    setReferences(data.references);
    setMetadataName(data.metadataName);
    setMetadataDescription(data.metadataDescription);
    setVariableDraft(data.variableDraft);
    setBindingRows(data.bindingRows);
    setNextBindingId(data.nextBindingId);
    setCopyName(data.copyName);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadEnvironment(selectedEnvironmentId)
      .then((data) => {
        if (cancelled) return;
        applyEnvironmentData(data);
        setError("");
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : "读取执行环境失败。");
      });
    return () => {
      cancelled = true;
    };
  }, [applyEnvironmentData, loadEnvironment, selectedEnvironmentId]);

  const selectedSecret = useMemo(
    () => secrets.find((secret) => secret.id === selectedSecretId) ?? null,
    [secrets, selectedSecretId],
  );

  const canManageEnvironment = (projectId: string) =>
    manageableProjectIds === null || manageableProjectIds.includes(projectId);
  const canManageSecret = (projectId: string) =>
    secretProjectIds === null || secretProjectIds.includes(projectId);
  const environmentProjectOptions = projects.filter((project) =>
    manageableProjectIds === null ? true : manageableProjectIds.includes(project.id),
  );
  const secretProjectOptions = projects.filter((project) =>
    secretProjectIds === null ? true : secretProjectIds.includes(project.id),
  );

  async function refreshEnvironments(preferredId?: string): Promise<void> {
    const page = await requestJson<{ items: ExecutionEnvironment[] }>(
      "/api/v1/execution-environments",
    );
    setEnvironments(page.items);
    const nextId = preferredId || selectedEnvironmentId || page.items[0]?.id || "";
    setSelectedEnvironmentId(nextId);
    applyEnvironmentData(await loadEnvironment(nextId));
  }

  async function environmentMutation(
    operation: () => Promise<ExecutionEnvironmentDetails>,
    successMessage: string,
  ): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const environment = await operation();
      await refreshEnvironments(environment.id);
      setNotice(successMessage);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "执行环境操作失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveMetadata(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details) return;
    await environmentMutation(
      () =>
        requestJson(`/api/v1/execution-environments/${encodeURIComponent(details.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            expectedRevision: details.revision,
            name: metadataName,
            description: metadataDescription,
          }),
        }),
      "环境元数据已更新。",
    );
  }

  async function saveVariables(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details) return;
    let variables;
    try {
      variables = parseVariables(variableDraft);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "变量格式无效。");
      return;
    }
    await environmentMutation(
      () =>
        requestJson(`/api/v1/execution-environments/${encodeURIComponent(details.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ expectedRevision: details.revision, variables }),
        }),
      "已创建新的普通变量版本。",
    );
  }

  async function saveBindings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details) return;
    await environmentMutation(
      () =>
        requestJson(`/api/v1/execution-environments/${encodeURIComponent(details.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            expectedRevision: details.revision,
            secretBindings: bindingRows.map(({ name, secretId }) => ({
              name: name.trim(),
              secretId,
            })),
          }),
        }),
      "已创建新的密文绑定版本。",
    );
  }

  async function copyEnvironment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details) return;
    await environmentMutation(
      () =>
        requestJson(`/api/v1/execution-environments/${encodeURIComponent(details.id)}/copy`, {
          method: "POST",
          body: JSON.stringify({ name: copyName }),
        }),
      "执行环境已复制。",
    );
  }

  async function toggleEnvironmentStatus() {
    if (!details) return;
    const status = details.status === "active" ? "disabled" : "active";
    if (
      !window.confirm(
        status === "disabled"
          ? `停用 ${details.name}？新批次将不能引用该环境。`
          : `重新启用 ${details.name}？`,
      )
    ) {
      return;
    }
    await environmentMutation(
      () =>
        requestJson(`/api/v1/execution-environments/${encodeURIComponent(details.id)}/status`, {
          method: "PUT",
          body: JSON.stringify({ expectedRevision: details.revision, status }),
        }),
      status === "active" ? "执行环境已启用。" : "执行环境已停用。",
    );
  }

  function addBinding(projectId: string) {
    const available = secrets.find(
      (secret) => secret.projectId === projectId && secret.status === "active",
    );
    if (!available) return;
    setBindingRows((current) => [
      ...current,
      { id: nextBindingId, name: "", secretId: available.id },
    ]);
    setNextBindingId((current) => current + 1);
  }

  return (
    <div className="environment-settings-stack">
      {error ? <p className="form-error settings-feedback">{error}</p> : null}
      {notice ? <p className="form-success settings-feedback">{notice}</p> : null}

      {activeView === "environments" ? (
        <EnvironmentPanel
          addBinding={addBinding}
          bindingRows={bindingRows}
          busy={busy}
          canManage={details ? canManageEnvironment(details.projectId) : false}
          copyEnvironment={copyEnvironment}
          copyName={copyName}
          details={details}
          environmentProjectOptions={environmentProjectOptions}
          environments={environments}
          metadataDescription={metadataDescription}
          metadataName={metadataName}
          references={references}
          saveBindings={saveBindings}
          saveMetadata={saveMetadata}
          saveVariables={saveVariables}
          secrets={secrets}
          selectedEnvironmentId={selectedEnvironmentId}
          setBindingRows={setBindingRows}
          setCopyName={setCopyName}
          setMetadataDescription={setMetadataDescription}
          setMetadataName={setMetadataName}
          setSelectedEnvironmentId={setSelectedEnvironmentId}
          setVariableDraft={setVariableDraft}
          toggleEnvironmentStatus={toggleEnvironmentStatus}
          variableDraft={variableDraft}
          versions={versions}
          onCreated={(environment) => refreshEnvironments(environment.id)}
        />
      ) : (
        <SecretPanel
          busy={busy}
          canManageSecret={canManageSecret}
          projects={secretProjectOptions}
          secrets={secrets}
          selectedSecret={selectedSecret}
          selectedSecretId={selectedSecretId}
          setBusy={setBusy}
          setError={setError}
          setNotice={setNotice}
          setSecrets={setSecrets}
          setSelectedSecretId={setSelectedSecretId}
        />
      )}
    </div>
  );
}

function EnvironmentPanel(props: {
  environments: ExecutionEnvironment[];
  selectedEnvironmentId: string;
  setSelectedEnvironmentId(value: string): void;
  details: ExecutionEnvironmentDetails | null;
  versions: ExecutionEnvironmentVersion[];
  references: { items: ExecutionEnvironmentReference[]; total: number };
  secrets: ExecutionSecret[];
  environmentProjectOptions: ProjectOption[];
  canManage: boolean;
  busy: boolean;
  metadataName: string;
  metadataDescription: string;
  variableDraft: string;
  bindingRows: BindingRow[];
  copyName: string;
  setMetadataName(value: string): void;
  setMetadataDescription(value: string): void;
  setVariableDraft(value: string): void;
  setBindingRows(value: BindingRow[] | ((current: BindingRow[]) => BindingRow[])): void;
  setCopyName(value: string): void;
  addBinding(projectId: string): void;
  saveMetadata(event: React.FormEvent<HTMLFormElement>): Promise<void>;
  saveVariables(event: React.FormEvent<HTMLFormElement>): Promise<void>;
  saveBindings(event: React.FormEvent<HTMLFormElement>): Promise<void>;
  copyEnvironment(event: React.FormEvent<HTMLFormElement>): Promise<void>;
  toggleEnvironmentStatus(): Promise<void>;
  onCreated(environment: ExecutionEnvironmentDetails): Promise<void>;
}) {
  const [showCreate, setShowCreate] = useState(false);
  return (
    <div className="environment-manager-grid">
      <section className="card environment-list-panel">
        <div className="section-heading">
          <div>
            <span className="step-label">ENV</span>
            <h2>执行环境</h2>
          </div>
          {props.environmentProjectOptions.length > 0 ? (
            <Button
              className="icon-button"
              type="button"
              aria-label="创建执行环境"
              title="创建执行环境"
              onClick={() => setShowCreate((current) => !current)}
            >
              <Plus size={17} />
            </Button>
          ) : null}
        </div>
        {showCreate ? (
          <CreateEnvironmentForm
            projects={props.environmentProjectOptions}
            secrets={props.secrets}
            onCreated={async (environment) => {
              await props.onCreated(environment);
              setShowCreate(false);
            }}
          />
        ) : null}
        <div className="environment-record-list">
          {props.environments.length === 0 ? (
            <div className="inline-empty">暂无可见执行环境。</div>
          ) : (
            props.environments.map((environment) => (
              <Button
                className={environment.id === props.selectedEnvironmentId ? "selected" : ""}
                key={environment.id}
                type="button"
                onClick={() => props.setSelectedEnvironmentId(environment.id)}
              >
                <span>
                  <strong>{environment.name}</strong>
                  <small>v{environment.currentVersion}</small>
                </span>
                <StatusLabel status={environment.status} />
              </Button>
            ))
          )}
        </div>
      </section>

      <section className="card environment-detail-panel">
        {!props.details ? (
          <div className="inline-empty">选择一个执行环境。</div>
        ) : (
          <>
            <div className="environment-detail-header">
              <div>
                <span className="step-label">{props.details.projectId}</span>
                <h2>{props.details.name}</h2>
              </div>
              <div className="environment-detail-actions">
                <StatusLabel status={props.details.status} />
                {props.canManage ? (
                  <Button
                    className="icon-button"
                    type="button"
                    aria-label={props.details.status === "active" ? "停用环境" : "启用环境"}
                    title={props.details.status === "active" ? "停用环境" : "启用环境"}
                    disabled={props.busy}
                    onClick={props.toggleEnvironmentStatus}
                  >
                    <Power size={17} />
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="environment-editor-grid">
              <form onSubmit={props.saveMetadata}>
                <h3>元数据</h3>
                <label className="field-stack">
                  <span>名称</span>
                  <Input
                    value={props.metadataName}
                    disabled={!props.canManage || props.busy}
                    onChange={(event) => props.setMetadataName(event.target.value)}
                  />
                </label>
                <label className="field-stack">
                  <span>说明</span>
                  <Textarea
                    rows={3}
                    value={props.metadataDescription}
                    disabled={!props.canManage || props.busy}
                    onChange={(event) => props.setMetadataDescription(event.target.value)}
                  />
                </label>
                {props.canManage ? <SubmitButton busy={props.busy} label="保存元数据" /> : null}
              </form>

              <form onSubmit={props.saveVariables}>
                <h3>普通变量新版本</h3>
                <label className="field-stack">
                  <span>变量</span>
                  <Textarea
                    rows={6}
                    value={props.variableDraft}
                    disabled={!props.canManage || props.busy}
                    onChange={(event) => props.setVariableDraft(event.target.value)}
                  />
                </label>
                {props.canManage ? <SubmitButton busy={props.busy} label="创建变量版本" /> : null}
              </form>

              <form onSubmit={props.saveBindings}>
                <div className="compact-section-heading">
                  <h3>密文绑定新版本</h3>
                  {props.canManage ? (
                    <Button
                      className="icon-button small-icon-button"
                      type="button"
                      aria-label="添加密文绑定"
                      title="添加密文绑定"
                      disabled={
                        props.busy ||
                        !props.secrets.some(
                          (secret) =>
                            secret.projectId === props.details?.projectId &&
                            secret.status === "active",
                        )
                      }
                      onClick={() => props.addBinding(props.details?.projectId ?? "")}
                    >
                      <Plus size={15} />
                    </Button>
                  ) : null}
                </div>
                <div className="secret-binding-list">
                  {props.bindingRows.length === 0 ? (
                    <div className="inline-empty">当前版本没有密文绑定。</div>
                  ) : (
                    props.bindingRows.map((row) => (
                      <div className="secret-binding-row" key={row.id}>
                        <Input
                          aria-label="注入变量名"
                          value={row.name}
                          disabled={!props.canManage || props.busy}
                          onChange={(event) =>
                            props.setBindingRows((current) =>
                              current.map((item) =>
                                item.id === row.id ? { ...item, name: event.target.value } : item,
                              ),
                            )
                          }
                        />
                        <Select
                          aria-label="执行密文"
                          value={row.secretId}
                          disabled={!props.canManage || props.busy}
                          onChange={(event) =>
                            props.setBindingRows((current) =>
                              current.map((item) =>
                                item.id === row.id
                                  ? { ...item, secretId: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        >
                          {props.secrets
                            .filter(
                              (secret) =>
                                secret.projectId === props.details?.projectId &&
                                (secret.status === "active" || secret.id === row.secretId),
                            )
                            .map((secret) => (
                              <option key={secret.id} value={secret.id}>
                                {secret.name} · v{secret.currentVersion}
                              </option>
                            ))}
                        </Select>
                        {props.canManage ? (
                          <Button
                            className="icon-button small-icon-button"
                            type="button"
                            aria-label="移除密文绑定"
                            title="移除密文绑定"
                            onClick={() =>
                              props.setBindingRows((current) =>
                                current.filter((item) => item.id !== row.id),
                              )
                            }
                          >
                            <Trash2 size={14} />
                          </Button>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
                {props.canManage ? <SubmitButton busy={props.busy} label="创建绑定版本" /> : null}
              </form>

              {props.canManage ? (
                <form onSubmit={props.copyEnvironment}>
                  <h3>复制环境</h3>
                  <label className="field-stack">
                    <span>新环境名称</span>
                    <Input
                      required
                      value={props.copyName}
                      disabled={props.busy}
                      onChange={(event) => props.setCopyName(event.target.value)}
                    />
                  </label>
                  <Button className="button button-secondary" type="submit" disabled={props.busy}>
                    <Copy size={15} /> 复制
                  </Button>
                </form>
              ) : null}
            </div>

            <div className="environment-history-grid">
              <section>
                <h3>版本</h3>
                <div className="environment-version-list">
                  {props.versions.map((version) => (
                    <div key={version.id}>
                      <strong>v{version.version}</strong>
                      <span>
                        {version.variables.map((entry) => entry.name).join(", ") || "无普通变量"}
                      </span>
                      <small>
                        {version.secretBindings.map((entry) => entry.name).join(", ") ||
                          "无密文绑定"}
                      </small>
                      <time dateTime={version.createdAt}>{formatDate(version.createdAt)}</time>
                    </div>
                  ))}
                </div>
              </section>
              <section>
                <h3>批次引用 · {props.references.total}</h3>
                <div className="environment-reference-list">
                  {props.references.items.length === 0 ? (
                    <div className="inline-empty">暂无执行批次引用。</div>
                  ) : (
                    props.references.items.map((reference) => (
                      <Link
                        href={`/run-batches/${encodeURIComponent(reference.batchId)}`}
                        key={reference.batchId}
                      >
                        <span>
                          <strong>{reference.suiteName}</strong>
                          <small>{reference.status}</small>
                        </span>
                        <time dateTime={reference.createdAt}>
                          {formatDate(reference.createdAt)}
                        </time>
                      </Link>
                    ))
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function CreateEnvironmentForm({
  projects,
  secrets,
  onCreated,
}: {
  projects: ProjectOption[];
  secrets: ExecutionSecret[];
  onCreated(environment: ExecutionEnvironmentDetails): Promise<void>;
}) {
  const [projectId, setProjectId] = useState(initialProjectId(projects));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [variables, setVariables] = useState("");
  const [bindings, setBindings] = useState<BindingRow[]>([]);
  const [nextId, setNextId] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const availableSecrets = secrets.filter(
    (secret) => secret.projectId === projectId && secret.status === "active",
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const environment = await requestJson<ExecutionEnvironmentDetails>(
        "/api/v1/execution-environments",
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            name,
            description,
            variables: parseVariables(variables),
            secretBindings: bindings.map(({ name: variableName, secretId }) => ({
              name: variableName.trim(),
              secretId,
            })),
          }),
        },
      );
      await onCreated(environment);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "创建执行环境失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="compact-create-form" onSubmit={submit}>
      <label className="field-stack">
        <span>项目</span>
        <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="field-stack">
        <span>名称</span>
        <Input required value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field-stack">
        <span>说明</span>
        <Input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label className="field-stack">
        <span>普通变量</span>
        <Textarea
          rows={4}
          value={variables}
          onChange={(event) => setVariables(event.target.value)}
        />
      </label>
      <div className="compact-section-heading">
        <strong>密文绑定</strong>
        <Button
          className="icon-button small-icon-button"
          type="button"
          aria-label="添加密文绑定"
          title="添加密文绑定"
          disabled={availableSecrets.length === 0}
          onClick={() => {
            const secret = availableSecrets[0];
            if (!secret) return;
            setBindings((current) => [...current, { id: nextId, name: "", secretId: secret.id }]);
            setNextId((current) => current + 1);
          }}
        >
          <Plus size={14} />
        </Button>
      </div>
      {bindings.map((binding) => (
        <div className="secret-binding-row" key={binding.id}>
          <Input
            aria-label="注入变量名"
            value={binding.name}
            onChange={(event) =>
              setBindings((current) =>
                current.map((item) =>
                  item.id === binding.id ? { ...item, name: event.target.value } : item,
                ),
              )
            }
          />
          <Select
            aria-label="执行密文"
            value={binding.secretId}
            onChange={(event) =>
              setBindings((current) =>
                current.map((item) =>
                  item.id === binding.id ? { ...item, secretId: event.target.value } : item,
                ),
              )
            }
          >
            {availableSecrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
              </option>
            ))}
          </Select>
          <Button
            className="icon-button small-icon-button"
            type="button"
            aria-label="移除密文绑定"
            onClick={() =>
              setBindings((current) => current.filter((item) => item.id !== binding.id))
            }
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      {error ? <p className="form-error">{error}</p> : null}
      <SubmitButton busy={submitting} label="创建环境" />
    </form>
  );
}

function SecretPanel(props: {
  projects: ProjectOption[];
  secrets: ExecutionSecret[];
  selectedSecretId: string;
  selectedSecret: ExecutionSecret | null;
  busy: boolean;
  canManageSecret(projectId: string): boolean;
  setSelectedSecretId(value: string): void;
  setSecrets(value: ExecutionSecret[] | ((current: ExecutionSecret[]) => ExecutionSecret[])): void;
  setBusy(value: boolean): void;
  setError(value: string): void;
  setNotice(value: string): void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId(props.projects));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [rotationValue, setRotationValue] = useState("");

  async function mutate(operation: () => Promise<ExecutionSecret>, message: string) {
    props.setBusy(true);
    props.setError("");
    props.setNotice("");
    try {
      const secret = await operation();
      props.setSecrets((current) => [secret, ...current.filter((entry) => entry.id !== secret.id)]);
      props.setSelectedSecretId(secret.id);
      props.setNotice(message);
      return secret;
    } catch (problem) {
      props.setError(problem instanceof Error ? problem.message : "执行密文操作失败。");
      return null;
    } finally {
      props.setBusy(false);
    }
  }

  async function createSecret(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await mutate(
      () =>
        requestJson("/api/v1/execution-secrets", {
          method: "POST",
          body: JSON.stringify({ projectId, name, description, value }),
        }),
      "执行密文已创建。",
    );
    if (created) {
      setName("");
      setDescription("");
      setValue("");
    }
  }

  async function rotateSecret(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.selectedSecret) return;
    const rotated = await mutate(
      () =>
        requestJson(
          `/api/v1/execution-secrets/${encodeURIComponent(props.selectedSecret?.id ?? "")}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              expectedRevision: props.selectedSecret?.revision,
              value: rotationValue,
            }),
          },
        ),
      "执行密文已轮换。",
    );
    if (rotated) setRotationValue("");
  }

  async function toggleSecretStatus() {
    if (!props.selectedSecret) return;
    const status = props.selectedSecret.status === "active" ? "disabled" : "active";
    if (
      !window.confirm(
        status === "disabled"
          ? `停用 ${props.selectedSecret.name}？引用它的新批次将被阻止。`
          : `重新启用 ${props.selectedSecret.name}？`,
      )
    ) {
      return;
    }
    await mutate(
      () =>
        requestJson(
          `/api/v1/execution-secrets/${encodeURIComponent(props.selectedSecret?.id ?? "")}/status`,
          {
            method: "PUT",
            body: JSON.stringify({ expectedRevision: props.selectedSecret?.revision, status }),
          },
        ),
      status === "active" ? "执行密文已启用。" : "执行密文已停用。",
    );
  }

  return (
    <div className="secret-manager-grid">
      <section className="card secret-create-panel">
        <div className="section-heading">
          <div>
            <span className="step-label">NEW</span>
            <h2>创建执行密文</h2>
          </div>
        </div>
        {props.projects.length === 0 ? (
          <div className="inline-empty">当前账号没有密文管理权限。</div>
        ) : (
          <form onSubmit={createSecret}>
            <label className="field-stack">
              <span>项目</span>
              <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {props.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field-stack">
              <span>名称</span>
              <Input required value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field-stack">
              <span>说明</span>
              <Input value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <label className="field-stack">
              <span>密文值</span>
              <Input
                required
                autoComplete="new-password"
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            <SubmitButton busy={props.busy} label="创建密文" />
          </form>
        )}
      </section>

      <section className="card secret-list-panel">
        <div className="section-heading">
          <div>
            <span className="step-label">META</span>
            <h2>密文元数据</h2>
          </div>
        </div>
        <div className="secret-record-list">
          {props.secrets.length === 0 ? (
            <div className="inline-empty">暂无可管理执行密文。</div>
          ) : (
            props.secrets.map((secret) => (
              <Button
                className={secret.id === props.selectedSecretId ? "selected" : ""}
                key={secret.id}
                type="button"
                onClick={() => props.setSelectedSecretId(secret.id)}
              >
                <span>
                  <strong>{secret.name}</strong>
                  <small>v{secret.currentVersion}</small>
                </span>
                <StatusLabel status={secret.status} />
              </Button>
            ))
          )}
        </div>
        {props.selectedSecret ? (
          <div className="secret-selected-detail">
            <dl>
              <div>
                <dt>项目</dt>
                <dd>{props.selectedSecret.projectId}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>v{props.selectedSecret.currentVersion}</dd>
              </div>
              <div>
                <dt>更新时间</dt>
                <dd>{formatDate(props.selectedSecret.updatedAt)}</dd>
              </div>
            </dl>
            {props.canManageSecret(props.selectedSecret.projectId) ? (
              <>
                <form className="secret-rotation-form" onSubmit={rotateSecret}>
                  <label className="field-stack">
                    <span>新密文值</span>
                    <Input
                      required
                      autoComplete="new-password"
                      type="password"
                      value={rotationValue}
                      onChange={(event) => setRotationValue(event.target.value)}
                    />
                  </label>
                  <Button className="button button-secondary" type="submit" disabled={props.busy}>
                    <RotateCcw size={15} /> 轮换
                  </Button>
                </form>
                <Button
                  className="button button-secondary"
                  type="button"
                  disabled={props.busy}
                  onClick={toggleSecretStatus}
                >
                  <Power size={15} />
                  {props.selectedSecret.status === "active" ? "停用" : "启用"}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SubmitButton({ busy, label }: { busy: boolean; label: string }) {
  return (
    <Button className="button button-primary" type="submit" disabled={busy}>
      {busy ? <RefreshCw className="spin" size={15} /> : <Save size={15} />}
      {label}
    </Button>
  );
}

function StatusLabel({ status }: { status: "active" | "disabled" }) {
  return (
    <span className={`environment-status environment-status-${status}`}>{statusLabel(status)}</span>
  );
}

function statusLabel(status: "active" | "disabled") {
  return status === "active" ? "启用" : "停用";
}

function formatVariables(variables: Array<{ name: string; value: string }>): string {
  return variables.map((variable) => `${variable.name}=${variable.value}`).join("\n");
}

function parseVariables(value: string): Array<{ name: string; value: string }> {
  const variables = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`第 ${index + 1} 行变量缺少名称或等号。`);
      const name = line.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
        throw new Error(`第 ${index + 1} 行变量名格式无效。`);
      }
      return { name, value: line.slice(separator + 1) };
    });
  if (new Set(variables.map((variable) => variable.name)).size !== variables.length) {
    throw new Error("普通变量名不能重复。");
  }
  return variables;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers,
  });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(apiMessage(result));
  return result as T;
}

function apiMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return "请求失败。";
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "请求失败。";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "请求失败。";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
