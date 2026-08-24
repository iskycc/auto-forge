"use client";

import type {
  ProjectAdapterConfiguration,
  ProjectRuntimeAsset,
  ProjectStructure,
} from "@autoforge/domain";
import { FolderTree, Link2, Plus, Trash2, UploadCloud } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button, FileInput, Input, OperationProgress, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { uploadWithProgress } from "@/lib/upload-with-progress";
import { ActionDialog } from "@/components/action-dialog";

export function ProjectStructureManager({
  projectId,
  initialStructure,
  initialVersionId,
  canManage,
}: {
  projectId: string;
  initialStructure: ProjectStructure;
  initialVersionId?: string;
  canManage: boolean;
}) {
  const [structure, setStructure] = useState(initialStructure);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [runtimeUploadProgress, setRuntimeUploadProgress] = useState<{
    label: string;
    detail: string;
    percent: number;
  }>();
  const [createDialog, setCreateDialog] = useState<"version" | "stage" | "inherit-cases" | null>(
    null,
  );
  const [selectedVersionId, setSelectedVersionId] = useState(
    initialStructure.versions.some((version) => version.id === initialVersionId)
      ? (initialVersionId ?? "")
      : (initialStructure.versions[0]?.id ?? ""),
  );

  async function refresh(success: string): Promise<void> {
    const response = await fetch(`/api/v1/projects/${projectId}/structure`, {
      cache: "no-store",
    });
    const errorMessage = await readApiErrorMessage(response, "刷新项目结构失败。");
    if (errorMessage) throw new Error(errorMessage);
    const nextStructure = (await response.json()) as ProjectStructure;
    setStructure(nextStructure);
    setSelectedVersionId((current) =>
      nextStructure.versions.some((version) => version.id === current)
        ? current
        : (nextStructure.versions[0]?.id ?? ""),
    );
    setMessage(success);
  }

  async function submitJson(path: string, method: "POST" | "PUT", body: unknown) {
    const response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const errorMessage = await readApiErrorMessage(response, "保存失败。");
    if (errorMessage) throw new Error(errorMessage);
    return response.json() as Promise<unknown>;
  }

  async function run(operation: () => Promise<void>): Promise<void> {
    setPending(true);
    setMessage("");
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setPending(false);
    }
  }

  function createVersion(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void run(async () => {
      await submitJson(`/api/v1/projects/${projectId}/versions`, "POST", {
        name: values.get("name"),
      });
      form.reset();
      await refresh("项目版本已创建。");
      setCreateDialog(null);
    });
  }

  function createStage(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const versionId = String(values.get("versionId") ?? "");
    void run(async () => {
      await submitJson(
        `/api/v1/projects/${projectId}/versions/${encodeURIComponent(versionId)}/stages`,
        "POST",
        { name: values.get("name"), description: values.get("description") },
      );
      form.reset();
      await refresh("测试阶段已创建。");
      setCreateDialog(null);
    });
  }

  function inheritCases(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const sourceStage = findStage(structure, String(values.get("sourceTestStageId") ?? ""));
    const targetStage = findStage(structure, String(values.get("targetTestStageId") ?? ""));
    if (!sourceStage || !targetStage) {
      setError("请选择有效的来源和目标测试阶段。");
      return;
    }
    void run(async () => {
      const result = (await submitJson(
        `/api/v1/projects/${projectId}/versions/${encodeURIComponent(targetStage.projectVersionId)}/inherit-cases`,
        "POST",
        {
          sourceProjectVersionId: sourceStage.projectVersionId,
          sourceTestStageId: sourceStage.id,
          targetTestStageId: targetStage.id,
        },
      )) as { inheritedCount: number; skippedCount: number };
      await refresh(
        `已继承 ${result.inheritedCount} 个用例${result.skippedCount ? `，跳过 ${result.skippedCount} 个同名用例` : ""}。`,
      );
      setCreateDialog(null);
    });
  }

  function registerUrlAsset(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const configuration = selectedVersionConfiguration(structure, selectedVersionId);
    if (!configuration) {
      setError("请先创建并选择项目版本。");
      return;
    }
    void run(async () => {
      const asset = (await submitJson(`/api/v1/projects/${projectId}/runtime-assets/url`, "POST", {
        kind: values.get("kind"),
        url: values.get("url"),
        fileName: values.get("fileName"),
        sha256: values.get("sha256"),
        sizeBytes: Number(values.get("sizeBytes")),
        archiveFormat: values.get("archiveFormat"),
      })) as ProjectRuntimeAsset;
      await saveConfiguration(selectedVersionId, withAsset(configuration, asset));
      form.reset();
      await refresh("运行时资源链接已登记并设为当前配置。");
    });
  }

  function uploadAsset(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const kind = String(values.get("kind"));
    const archiveFormat = String(values.get("archiveFormat"));
    const file = values.get("file");
    const configuration = selectedVersionConfiguration(structure, selectedVersionId);
    if (!configuration) {
      setError("请先创建并选择项目版本。");
      return;
    }
    if (!(file instanceof File) || file.size === 0) {
      setError("请选择非空运行时压缩包。");
      return;
    }
    const assetLabel = kind === "jdk" ? "JDK 压缩包" : "依赖 JAR 压缩包";
    const uploadDetail = `${file.name} · ${formatBytes(file.size)}`;
    void run(async () => {
      setRuntimeUploadProgress({
        label: `正在上传${assetLabel}`,
        detail: uploadDetail,
        percent: 0,
      });
      try {
        const response = await uploadWithProgress({
          url: `/api/v1/projects/${projectId}/runtime-assets/upload?${new URLSearchParams({ kind, archiveFormat })}`,
          method: "POST",
          headers: {
            "content-type": archiveFormat === "zip" ? "application/zip" : "application/gzip",
            "x-autoforge-file-name": encodeURIComponent(file.name),
          },
          body: file,
          onProgress: ({ percent }) =>
            setRuntimeUploadProgress({
              label: `正在上传${assetLabel}`,
              detail: uploadDetail,
              percent,
            }),
          onUploadComplete: () =>
            setRuntimeUploadProgress({
              label: "上传完成，正在校验压缩包",
              detail: `${assetLabel} · ${uploadDetail}`,
              percent: 100,
            }),
        });
        const errorMessage = await readApiErrorMessage(response, "上传运行时资源失败。");
        if (errorMessage) throw new Error(errorMessage);
        const asset = (await response.json()) as ProjectRuntimeAsset;
        setRuntimeUploadProgress({
          label: "压缩包已保存，正在启用当前版本",
          detail: `${assetLabel} · ${uploadDetail}`,
          percent: 100,
        });
        await saveConfiguration(selectedVersionId, withAsset(configuration, asset));
        form.reset();
        await refresh("运行时资源已上传并设为当前配置。");
        setRuntimeUploadProgress({
          label: "运行时资源上传完成",
          detail: `${assetLabel} · ${uploadDetail}`,
          percent: 100,
        });
      } catch (cause) {
        setRuntimeUploadProgress(undefined);
        throw cause;
      }
    });
  }

  async function saveConfiguration(
    versionId: string,
    configuration: ProjectAdapterConfiguration,
  ): Promise<void> {
    await submitJson(
      `/api/v1/projects/${projectId}/versions/${encodeURIComponent(versionId)}/adapter-configuration`,
      "PUT",
      {
        ...(configuration.jdkAsset ? { jdkAssetId: configuration.jdkAsset.id } : {}),
        ...(configuration.jarBundleAsset
          ? { jarBundleAssetId: configuration.jarBundleAsset.id }
          : {}),
        expectedRevision: configuration.revision,
      },
    );
  }

  function inheritRuntime(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const configuration = selectedVersionConfiguration(structure, selectedVersionId);
    if (!configuration) return;
    const values = new FormData(event.currentTarget);
    void run(async () => {
      await submitJson(
        `/api/v1/projects/${projectId}/versions/${encodeURIComponent(selectedVersionId)}/inherit-runtime`,
        "POST",
        {
          sourceProjectVersionId: values.get("sourceProjectVersionId"),
          expectedRevision: configuration.revision,
        },
      );
      await refresh("已通过共享对象引用继承运行时资源，不会重复上传文件。");
    });
  }

  function deleteAsset(kind: "jdk" | "jar-bundle"): void {
    const configuration = selectedVersionConfiguration(structure, selectedVersionId);
    if (!configuration) return;
    const label = kind === "jdk" ? "JDK 压缩包" : "依赖 JAR 压缩包";
    if (!window.confirm(`删除当前版本的${label}？其他继承版本的引用不会受影响。`)) return;
    void run(async () => {
      const query = new URLSearchParams({
        kind,
        expectedRevision: String(configuration.revision),
      });
      const response = await fetch(
        `/api/v1/projects/${projectId}/versions/${encodeURIComponent(selectedVersionId)}/adapter-configuration?${query}`,
        { method: "DELETE" },
      );
      const errorMessage = await readApiErrorMessage(response, `删除${label}失败。`);
      if (errorMessage) throw new Error(errorMessage);
      await refresh(`${label}已从当前版本删除。`);
    });
  }

  const selectedVersion = structure.versions.find((version) => version.id === selectedVersionId);
  const configuration = selectedVersion?.adapterConfiguration ?? {
    projectId,
    projectVersionId: selectedVersionId,
    revision: 0,
    updatedAt: "",
  };
  return (
    <div className="settings-stack project-structure-manager">
      {message ? <div className="inline-success">{message}</div> : null}
      {error ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Project structure</p>
            <h2>版本与测试阶段</h2>
            <p>新用例必须归属到项目版本和测试阶段；旧的未归属用例不进入新目录树。</p>
          </div>
          <div className="button-row">
            {canManage ? (
              <>
                <Button onClick={() => setCreateDialog("version")} type="button">
                  <Plus size={15} /> 创建版本
                </Button>
                <Button onClick={() => setCreateDialog("stage")} type="button">
                  <Plus size={15} /> 创建阶段
                </Button>
                <Button onClick={() => setCreateDialog("inherit-cases")} type="button">
                  <Link2 size={15} /> 继承用例
                </Button>
              </>
            ) : (
              <FolderTree size={22} aria-hidden="true" />
            )}
          </div>
        </div>
        <ActionDialog
          onClose={() => !pending && setCreateDialog(null)}
          open={createDialog === "version"}
          title="创建项目版本"
        >
          <form className="settings-grid-form action-dialog-form" onSubmit={createVersion}>
            <label>
              版本名称
              <Input name="name" placeholder="例如 2.4.0" required disabled={!canManage} />
            </label>
            <Button className="primary-button" disabled={pending || !canManage} type="submit">
              创建版本
            </Button>
          </form>
        </ActionDialog>
        <ActionDialog
          onClose={() => !pending && setCreateDialog(null)}
          open={createDialog === "inherit-cases"}
          title="从其他版本继承用例"
        >
          <form className="settings-grid-form action-dialog-form" onSubmit={inheritCases}>
            <label>
              来源版本 / 测试阶段
              <Select name="sourceTestStageId" required disabled={!canManage}>
                {structure.versions.flatMap((version) =>
                  version.stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {version.name} / {stage.name}
                    </option>
                  )),
                )}
              </Select>
            </label>
            <label>
              目标版本 / 测试阶段
              <Select name="targetTestStageId" required disabled={!canManage}>
                {structure.versions.flatMap((version) =>
                  version.stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {version.name} / {stage.name}
                    </option>
                  )),
                )}
              </Select>
            </label>
            <p className="settings-note">
              继承会创建独立的目标用例定义，并共享不可变 JAR
              来源；目标阶段已有的同类名用例会安全跳过。
            </p>
            <Button
              className="primary-button"
              disabled={pending || !canManage || structure.versions.length < 2}
              type="submit"
            >
              开始继承
            </Button>
          </form>
        </ActionDialog>
        <ActionDialog
          onClose={() => !pending && setCreateDialog(null)}
          open={createDialog === "stage"}
          title="创建测试阶段"
        >
          <form className="settings-grid-form action-dialog-form" onSubmit={createStage}>
            <label>
              所属版本
              <Select name="versionId" required disabled={!canManage}>
                {structure.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              阶段名称
              <Input name="name" placeholder="例如 系统测试" required disabled={!canManage} />
            </label>
            <label>
              阶段说明
              <Input name="description" maxLength={2000} disabled={!canManage} />
            </label>
            <Button
              className="primary-button"
              disabled={pending || !canManage || structure.versions.length === 0}
              type="submit"
            >
              创建测试阶段
            </Button>
          </form>
        </ActionDialog>
        <div className="project-version-tree" role="tree" aria-label="项目版本与测试阶段">
          {structure.versions.length === 0 ? (
            <p className="inline-empty">尚未创建项目版本。</p>
          ) : null}
          {structure.versions.map((version) => (
            <section
              aria-selected={version.id === selectedVersionId}
              className="project-version-node"
              key={version.id}
              role="treeitem"
            >
              <div className="project-version-node-heading">
                <span className="project-version-branch" aria-hidden="true" />
                <span>
                  <small>项目版本</small>
                  <strong>{version.name}</strong>
                </span>
                <span className="status-badge status-ready">
                  {version.stages.length} 个测试阶段
                </span>
              </div>
              <div className="project-stage-children" role="group">
                {version.stages.length === 0 ? (
                  <p className="project-stage-empty">尚无测试阶段</p>
                ) : (
                  version.stages.map((stage, index) => (
                    <div
                      aria-selected={false}
                      className="project-stage-node"
                      key={stage.id}
                      role="treeitem"
                    >
                      <span
                        className={
                          index === version.stages.length - 1
                            ? "project-stage-connector last"
                            : "project-stage-connector"
                        }
                        aria-hidden="true"
                      />
                      <span>
                        <small>测试阶段 {index + 1}</small>
                        <strong>{stage.name}</strong>
                        {stage.description ? <em>{stage.description}</em> : null}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      </section>

      <section className="content-card settings-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Runtime assets</p>
            <h2>JDK 与依赖 JAR 压缩包</h2>
            <p>
              可以流式上传或填写内网 HTTP(S) 地址；不设置固定业务大小上限，Runner
              下载后仍会校验大小、SHA-256 和任务工作区配额。
            </p>
          </div>
          <UploadCloud size={22} aria-hidden="true" />
        </div>
        <label className="project-runtime-version-select">
          配置所属版本
          <Select
            value={selectedVersionId}
            onChange={(event) => {
              setSelectedVersionId(event.currentTarget.value);
              setRuntimeUploadProgress(undefined);
            }}
            disabled={structure.versions.length === 0}
          >
            {structure.versions.length === 0 ? <option value="">尚无项目版本</option> : null}
            {structure.versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.name}
              </option>
            ))}
          </Select>
        </label>
        <p className="settings-note">
          {selectedVersion ? `${selectedVersion.name} · ` : ""}当前 JDK：
          {assetSummary(configuration.jdkAsset)}；当前依赖包：
          {assetSummary(configuration.jarBundleAsset)}
          {configuration.inheritedFromProjectVersionId
            ? `；继承自 ${versionName(structure, configuration.inheritedFromProjectVersionId)}`
            : ""}
        </p>
        <div className="project-runtime-actions">
          <Button
            disabled={pending || !canManage || !configuration.jdkAsset}
            onClick={() => deleteAsset("jdk")}
            type="button"
            variant="danger"
          >
            <Trash2 size={14} /> 删除当前 JDK
          </Button>
          <Button
            disabled={pending || !canManage || !configuration.jarBundleAsset}
            onClick={() => deleteAsset("jar-bundle")}
            type="button"
            variant="danger"
          >
            <Trash2 size={14} /> 删除当前依赖包
          </Button>
        </div>
        <form className="project-runtime-inherit" onSubmit={inheritRuntime}>
          <label>
            从其他版本继承资源
            <Select name="sourceProjectVersionId" required disabled={!canManage || pending}>
              {structure.versions
                .filter(
                  (version) =>
                    version.id !== selectedVersionId &&
                    (version.adapterConfiguration.jdkAsset ||
                      version.adapterConfiguration.jarBundleAsset),
                )
                .map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.name}
                  </option>
                ))}
            </Select>
          </label>
          <Button
            disabled={
              pending ||
              !canManage ||
              !selectedVersionId ||
              !structure.versions.some(
                (version) =>
                  version.id !== selectedVersionId &&
                  (version.adapterConfiguration.jdkAsset ||
                    version.adapterConfiguration.jarBundleAsset),
              )
            }
            type="submit"
          >
            <Link2 size={14} /> 继承共享资源
          </Button>
        </form>
        <div className="settings-paired-forms">
          <form
            className="settings-grid-form settings-subform project-structure-subform"
            onSubmit={uploadAsset}
          >
            <label>
              资源类型
              <Select name="kind" disabled={!canManage}>
                <option value="jdk">JDK 压缩包</option>
                <option value="jar-bundle">依赖 JAR 压缩包</option>
              </Select>
            </label>
            <label>
              压缩格式
              <Select name="archiveFormat" disabled={!canManage}>
                <option value="tar.gz">tar.gz</option>
                <option value="zip">zip</option>
              </Select>
            </label>
            <label>
              本地文件
              <FileInput name="file" accept=".zip,.tar.gz,.tgz" disabled={!canManage} />
            </label>
            <Button className="primary-button" disabled={pending || !canManage} type="submit">
              上传并启用
            </Button>
            {runtimeUploadProgress ? (
              <div className="project-runtime-upload-progress">
                <OperationProgress
                  detail={runtimeUploadProgress.detail}
                  label={runtimeUploadProgress.label}
                  value={runtimeUploadProgress.percent}
                />
              </div>
            ) : null}
          </form>
          <form
            className="settings-grid-form settings-subform project-structure-subform"
            onSubmit={registerUrlAsset}
          >
            <label>
              资源类型
              <Select name="kind" disabled={!canManage}>
                <option value="jdk">JDK 压缩包</option>
                <option value="jar-bundle">依赖 JAR 压缩包</option>
              </Select>
            </label>
            <label>
              压缩格式
              <Select name="archiveFormat" disabled={!canManage}>
                <option value="tar.gz">tar.gz</option>
                <option value="zip">zip</option>
              </Select>
            </label>
            <label>
              HTTP(S) 链接
              <Input name="url" type="url" required disabled={!canManage} />
            </label>
            <label>
              文件名
              <Input name="fileName" required disabled={!canManage} />
            </label>
            <label>
              SHA-256
              <Input name="sha256" minLength={64} maxLength={64} required disabled={!canManage} />
            </label>
            <label>
              大小（字节）
              <Input name="sizeBytes" type="number" min={1} required disabled={!canManage} />
            </label>
            <Button className="primary-button" disabled={pending || !canManage} type="submit">
              登记链接并启用
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}

function selectedVersionConfiguration(
  structure: ProjectStructure,
  versionId: string,
): ProjectAdapterConfiguration | undefined {
  return structure.versions.find((version) => version.id === versionId)?.adapterConfiguration;
}

function versionName(structure: ProjectStructure, versionId: string): string {
  return structure.versions.find((version) => version.id === versionId)?.name ?? "其他版本";
}

function findStage(structure: ProjectStructure, stageId: string) {
  for (const version of structure.versions) {
    const stage = version.stages.find((candidate) => candidate.id === stageId);
    if (stage) return stage;
  }
  return undefined;
}

function withAsset(
  configuration: ProjectAdapterConfiguration,
  asset: ProjectRuntimeAsset,
): ProjectAdapterConfiguration {
  return asset.kind === "jdk"
    ? { ...configuration, jdkAsset: asset }
    : { ...configuration, jarBundleAsset: asset };
}

function assetSummary(asset: ProjectRuntimeAsset | undefined): string {
  if (!asset) return "未配置";
  return `${asset.fileName}（${asset.sourceType === "upload" ? "已上传" : "链接"}）`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
