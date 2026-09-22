"use client";

import type {
  ProjectAdapterConfiguration,
  ProjectRuntimeAsset,
  ProjectStructure,
} from "@autoforge/domain";
import { FolderTree, Link2, Trash2, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button, FileInput, Input, OperationProgress, Select } from "@/components/ui";
import { readApiError, readApiErrorMessage } from "@/lib/client-api";
import { uploadWithProgress } from "@/lib/upload-with-progress";
import { ActionDialog } from "@/components/action-dialog";
import { useConcurrentModificationFeedback } from "@/components/concurrent-modification-feedback";
import { useConfirm, useToast } from "@/components/ui-feedback";

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
  const router = useRouter();
  const confirmAction = useConfirm();
  const showConcurrentModification = useConcurrentModificationFeedback();
  const toast = useToast();
  const [structure, setStructure] = useState(initialStructure);
  const [versionQuery, setVersionQuery] = useState("");
  const versionListRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [runtimeUploadProgress, setRuntimeUploadProgress] = useState<{
    label: string;
    detail: string;
    percent: number;
  }>();
  const [inheritDialogOpen, setInheritDialogOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState(
    initialStructure.versions.some((version) => version.id === initialVersionId)
      ? (initialVersionId ?? "")
      : (initialStructure.versions[0]?.id ?? ""),
  );

  useEffect(() => {
    const list = versionListRef.current;
    const selected = list?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!list || !selected) return;
    // Scroll only the version rail; selecting or clearing a filter must not move the page.
    const top = selected.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + selected.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top + selected.offsetHeight - list.clientHeight;
  }, [selectedVersionId, versionQuery]);

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
    toast.success(success);
    router.refresh();
  }

  async function submitJson(path: string, method: "POST" | "PUT", body: unknown) {
    const response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const apiError = await readApiError(response, "保存失败。");
    if (apiError) throw apiError;
    return response.json() as Promise<unknown>;
  }

  async function run(operation: () => Promise<void>): Promise<void> {
    setPending(true);
    setError("");
    toast.dismissAll();
    try {
      await operation();
    } catch (cause) {
      if (await showConcurrentModification(cause)) return;
      setError(cause instanceof Error ? cause.message : "操作失败。");
    } finally {
      setPending(false);
    }
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
      setInheritDialogOpen(false);
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
        const apiError = await readApiError(response, "上传运行时资源失败。");
        if (apiError) throw apiError;
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

  async function deleteAsset(kind: "jdk" | "jar-bundle"): Promise<void> {
    const configuration = selectedVersionConfiguration(structure, selectedVersionId);
    if (!configuration) return;
    const label = kind === "jdk" ? "JDK 压缩包" : "依赖 JAR 压缩包";
    if (
      !(await confirmAction({
        title: `删除${label}`,
        description: `将从当前版本删除${label}，其他继承版本的引用不会受影响。`,
        confirmLabel: "确认删除",
        tone: "danger",
      }))
    )
      return;
    void run(async () => {
      const query = new URLSearchParams({
        kind,
        expectedRevision: String(configuration.revision),
      });
      const response = await fetch(
        `/api/v1/projects/${projectId}/versions/${encodeURIComponent(selectedVersionId)}/adapter-configuration?${query}`,
        { method: "DELETE" },
      );
      const apiError = await readApiError(response, `删除${label}失败。`);
      if (apiError) throw apiError;
      await refresh(`${label}已从当前版本删除。`);
    });
  }

  const selectedVersion = structure.versions.find((version) => version.id === selectedVersionId);
  const matchingVersions = structure.versions.filter((version) =>
    version.name.toLocaleLowerCase().includes(versionQuery.trim().toLocaleLowerCase()),
  );
  const runtimeSourceVersions = structure.versions.filter(
    (version) =>
      version.id !== selectedVersionId &&
      (version.adapterConfiguration.jdkAsset || version.adapterConfiguration.jarBundleAsset),
  );
  const configuration = selectedVersion?.adapterConfiguration ?? {
    projectId,
    projectVersionId: selectedVersionId,
    revision: 0,
    updatedAt: "",
  };
  return (
    <div className="settings-stack project-structure-manager">
      {error && !inheritDialogOpen ? (
        <div className="auth-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="project-structure-workspace">
        <aside className="project-version-navigation" aria-label="配置所属版本">
          <div className="project-version-navigation-heading">
            <strong>项目版本</strong>
            <span>{structure.versions.length}</span>
          </div>
          <Input
            aria-label="搜索项目版本"
            placeholder="搜索版本名称"
            type="search"
            value={versionQuery}
            onChange={(event) => setVersionQuery(event.target.value)}
          />
          <div className="project-version-options" ref={versionListRef}>
            {matchingVersions.map((version) => (
              <Button
                key={version.id}
                type="button"
                className="project-version-option"
                aria-pressed={version.id === selectedVersionId}
                disabled={pending}
                onClick={() => {
                  setSelectedVersionId(version.id);
                  setRuntimeUploadProgress(undefined);
                  setError("");
                }}
              >
                <strong title={version.name}>{version.name}</strong>
                <span>
                  {version.stages.length} 个阶段 ·{" "}
                  {version.adapterConfiguration.jarBundleAsset ? "依赖已配置" : "未配置依赖"}
                </span>
              </Button>
            ))}
            {!matchingVersions.length ? (
              <p className="inline-empty">
                {structure.versions.length ? "没有匹配的版本" : "暂无版本，请从顶栏新建"}
              </p>
            ) : null}
          </div>
        </aside>
        <div className="project-version-detail">
          <section className="content-card settings-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Project structure</p>
                <h2 title={selectedVersion?.name}>{selectedVersion?.name ?? "版本与测试阶段"}</h2>
                <p>当前配置版本 · {selectedVersion?.stages.length ?? 0} 个测试阶段</p>
              </div>
              <div className="button-row">
                {canManage ? (
                  <>
                    <Button
                      onClick={() => (setError(""), setInheritDialogOpen(true))}
                      type="button"
                    >
                      <Link2 size={15} /> 继承用例
                    </Button>
                  </>
                ) : (
                  <FolderTree size={22} aria-hidden="true" />
                )}
              </div>
            </div>
            <ActionDialog
              protectUnsavedChanges
              onClose={() => !pending && setInheritDialogOpen(false)}
              open={inheritDialogOpen}
              title="从其他版本继承用例"
            >
              <form className="settings-grid-form action-dialog-form" onSubmit={inheritCases}>
                {error ? (
                  <p className="auth-error settings-wide-field" role="alert">
                    {error}
                  </p>
                ) : null}
                <label>
                  来源版本 / 测试阶段
                  <Select
                    name="sourceTestStageId"
                    required
                    disabled={!canManage || pending || !selectedVersionId}
                  >
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
                  <Select
                    name="targetTestStageId"
                    required
                    disabled={!canManage || pending || !selectedVersionId}
                  >
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
            <div className="project-stage-list" aria-label="当前版本测试阶段">
              {selectedVersion?.stages.length ? (
                selectedVersion.stages.map((stage) => (
                  <div className="project-stage-row" key={stage.id}>
                    <strong title={stage.name}>{stage.name}</strong>
                    <span>{stage.description || "暂无阶段说明"}</span>
                  </div>
                ))
              ) : (
                <p className="inline-empty">当前版本尚无测试阶段。</p>
              )}
            </div>
          </section>

          <section className="content-card settings-section" key={selectedVersionId}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">Runtime assets</p>
                <h2>JDK 与依赖 JAR 压缩包</h2>
                <p>资源仅应用于当前配置版本，支持上传、内网链接或从其他版本继承。</p>
              </div>
              <UploadCloud size={22} aria-hidden="true" />
            </div>
            <p className="settings-note">
              {selectedVersion ? `${selectedVersion.name} · ` : ""}当前 JDK：
              {assetSummary(configuration.jdkAsset)}；当前依赖包：
              {assetSummary(configuration.jarBundleAsset)}
              {configuration.inheritedFromProjectVersionId
                ? `；继承自 ${versionName(structure, configuration.inheritedFromProjectVersionId)}`
                : ""}
            </p>
            {configuration.jdkAsset || configuration.jarBundleAsset ? (
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
            ) : null}
            {runtimeSourceVersions.length ? (
              <form className="project-runtime-inherit" onSubmit={inheritRuntime}>
                <label>
                  从其他版本继承资源
                  <Select name="sourceProjectVersionId" required disabled={!canManage || pending}>
                    {runtimeSourceVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <Button disabled={pending || !canManage || !selectedVersionId} type="submit">
                  <Link2 size={14} /> 继承共享资源
                </Button>
              </form>
            ) : null}
            <div className="settings-paired-forms">
              <details className="management-disclosure">
                <summary>上传本地压缩包</summary>
                <form
                  className="settings-grid-form settings-subform project-structure-subform"
                  onSubmit={uploadAsset}
                >
                  <label>
                    资源类型
                    <Select name="kind" disabled={!canManage || pending || !selectedVersionId}>
                      <option value="jdk">JDK 压缩包</option>
                      <option value="jar-bundle">依赖 JAR 压缩包</option>
                    </Select>
                  </label>
                  <label>
                    压缩格式
                    <Select
                      name="archiveFormat"
                      disabled={!canManage || pending || !selectedVersionId}
                    >
                      <option value="tar.gz">tar.gz</option>
                      <option value="zip">zip</option>
                    </Select>
                  </label>
                  <label>
                    本地文件
                    <FileInput
                      name="file"
                      accept=".zip,.tar.gz,.tgz"
                      disabled={!canManage || pending || !selectedVersionId}
                    />
                  </label>
                  <Button
                    className="primary-button"
                    disabled={pending || !canManage || !selectedVersionId}
                    type="submit"
                  >
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
              </details>
              <details className="management-disclosure">
                <summary>登记内网资源链接</summary>
                <form
                  className="settings-grid-form settings-subform project-structure-subform"
                  onSubmit={registerUrlAsset}
                >
                  <label>
                    资源类型
                    <Select name="kind" disabled={!canManage || pending || !selectedVersionId}>
                      <option value="jdk">JDK 压缩包</option>
                      <option value="jar-bundle">依赖 JAR 压缩包</option>
                    </Select>
                  </label>
                  <label>
                    压缩格式
                    <Select
                      name="archiveFormat"
                      disabled={!canManage || pending || !selectedVersionId}
                    >
                      <option value="tar.gz">tar.gz</option>
                      <option value="zip">zip</option>
                    </Select>
                  </label>
                  <label>
                    HTTP(S) 链接
                    <Input
                      name="url"
                      type="url"
                      required
                      disabled={!canManage || pending || !selectedVersionId}
                    />
                  </label>
                  <label>
                    文件名
                    <Input
                      name="fileName"
                      required
                      disabled={!canManage || pending || !selectedVersionId}
                    />
                  </label>
                  <label>
                    SHA-256
                    <Input
                      name="sha256"
                      minLength={64}
                      maxLength={64}
                      required
                      disabled={!canManage || pending || !selectedVersionId}
                    />
                  </label>
                  <label>
                    大小（字节）
                    <Input
                      name="sizeBytes"
                      type="number"
                      min={1}
                      required
                      disabled={!canManage || pending || !selectedVersionId}
                    />
                  </label>
                  <Button
                    className="primary-button"
                    disabled={pending || !canManage || !selectedVersionId}
                    type="submit"
                  >
                    登记链接并启用
                  </Button>
                </form>
              </details>
            </div>
          </section>
        </div>
      </div>
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
