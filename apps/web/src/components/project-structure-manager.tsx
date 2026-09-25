"use client";
import { EmptyState } from "@/components/ui/empty-state";

import { Notice } from "@/components/ui/notice";

import { Disclosure } from "@/components/ui/disclosure";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type {
  ProjectAdapterConfiguration,
  ProjectRuntimeAsset,
  ProjectStructure,
} from "@autoforge/domain";
import { CheckCircle2, FolderTree, Link2, Trash2, UploadCloud } from "lucide-react";
import { Tag } from "antd";
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
    const padding = Number.parseFloat(window.getComputedStyle(list).paddingTop) || 0;
    if (top < list.scrollTop + padding) list.scrollTop = top - padding;
    else if (top + selected.offsetHeight > list.scrollTop + list.clientHeight - padding)
      list.scrollTop = top + selected.offsetHeight - list.clientHeight + padding;
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
    <div
      className={cn(
        "settings-stack project-structure-manager",
        uiPatterns["settings-stack"],
        projectStructureManagerStyles["project-structure-manager"],
      )}
    >
      {error && !inheritDialogOpen ? (
        <Notice tone="error" className={cn("auth-error", uiPatterns["auth-error"])} role="alert">
          {error}
        </Notice>
      ) : null}

      <div
        className={cn(
          "project-structure-workspace",
          projectStructureManagerStyles["project-structure-workspace"],
        )}
      >
        <aside
          className={cn(
            "project-version-navigation",
            projectStructureManagerStyles["project-version-navigation"],
          )}
          aria-label="配置所属版本"
        >
          <div
            className={cn(
              "project-version-navigation-heading",
              projectStructureManagerStyles["project-version-navigation-heading"],
            )}
          >
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
          <div
            className={cn(
              "project-version-options",
              projectStructureManagerStyles["project-version-options"],
            )}
            ref={versionListRef}
          >
            {matchingVersions.map((version) => (
              <Button
                key={version.id}
                type="button"
                variant="ghost"
                title={version.name}
                className={cn(
                  "project-version-option",
                  projectStructureManagerStyles["project-version-option"],
                )}
                aria-pressed={version.id === selectedVersionId}
                disabled={pending}
                onClick={() => {
                  setSelectedVersionId(version.id);
                  setRuntimeUploadProgress(undefined);
                  setError("");
                }}
              >
                <span className="grid w-full min-w-0 gap-1 text-left">
                  <span className="flex min-w-0 items-center gap-2">
                    <strong className="min-w-0 flex-1 truncate font-medium">{version.name}</strong>
                    <CheckCircle2
                      size={14}
                      aria-hidden="true"
                      className={cn(
                        "shrink-0 text-primary-text",
                        version.id !== selectedVersionId && "invisible",
                      )}
                    />
                  </span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {version.stages.length} 个阶段 ·{" "}
                    {version.adapterConfiguration.jarBundleAsset ? "依赖已配置" : "未配置依赖"}
                  </span>
                </span>
              </Button>
            ))}
            {!matchingVersions.length ? (
              <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
                {structure.versions.length ? "没有匹配的版本" : "暂无版本，请从顶栏新建"}
              </EmptyState>
            ) : null}
          </div>
        </aside>
        <div
          className={cn(
            "project-version-detail",
            projectStructureManagerStyles["project-version-detail"],
          )}
        >
          <Card
            as="section"
            className={cn(
              "content-card settings-section",
              uiPatterns["content-card"],
              uiPatterns["settings-section"],
              "grid gap-4 p-4",
            )}
          >
            <div
              className={cn(
                "section-heading",
                uiPatterns["section-heading"],
                "mb-0 [&_h2]:[overflow-wrap:anywhere]",
              )}
            >
              <div>
                <p className={cn("eyebrow", uiPatterns["eyebrow"])}>版本配置</p>
                <h2 title={selectedVersion?.name}>{selectedVersion?.name ?? "版本与测试阶段"}</h2>
                <p>当前配置版本 · {selectedVersion?.stages.length ?? 0} 个测试阶段</p>
              </div>
              <div className={cn("button-row", uiPatterns["button-row"])}>
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
              <form
                className={cn(
                  "settings-grid-form action-dialog-form",
                  uiPatterns["settings-grid-form"],
                  projectStructureManagerStyles["action-dialog-form"],
                )}
                onSubmit={inheritCases}
              >
                {error ? (
                  <Notice
                    tone="error"
                    className={cn(
                      "auth-error settings-wide-field",
                      uiPatterns["auth-error"],
                      uiPatterns["settings-wide-field"],
                    )}
                    role="alert"
                  >
                    {error}
                  </Notice>
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
                <p className={cn("settings-note", uiPatterns["settings-note"])}>
                  继承会创建独立的目标用例定义，并共享不可变 JAR
                  来源；目标阶段已有的同类名用例会安全跳过。
                </p>
                <Button
                  className={cn("primary-button", uiPatterns["primary-button"])}
                  disabled={pending || !canManage || structure.versions.length < 2}
                  type="submit"
                >
                  开始继承
                </Button>
              </form>
            </ActionDialog>
            <div
              className={cn(
                "project-stage-list",
                projectStructureManagerStyles["project-stage-list"],
              )}
              aria-label="当前版本测试阶段"
            >
              {selectedVersion?.stages.length ? (
                selectedVersion.stages.map((stage) => (
                  <div
                    className={cn(
                      "project-stage-row",
                      projectStructureManagerStyles["project-stage-row"],
                    )}
                    key={stage.id}
                  >
                    <strong title={stage.name}>{stage.name}</strong>
                    <span>{stage.description || "暂无阶段说明"}</span>
                  </div>
                ))
              ) : (
                <EmptyState className={cn("inline-empty", uiPatterns["inline-empty"])}>
                  当前版本尚无测试阶段。
                </EmptyState>
              )}
            </div>
          </Card>

          <Card
            as="section"
            className={cn(
              "content-card settings-section",
              uiPatterns["content-card"],
              uiPatterns["settings-section"],
              "grid gap-4 p-4",
            )}
            key={selectedVersionId}
          >
            <div
              className={cn(
                "section-heading",
                uiPatterns["section-heading"],
                "mb-0 [&_h2]:[overflow-wrap:anywhere]",
              )}
            >
              <div>
                <p className={cn("eyebrow", uiPatterns["eyebrow"])}>运行时资源</p>
                <h2>JDK 与依赖 JAR 压缩包</h2>
                <p>资源仅应用于当前配置版本，支持上传、内网链接或从其他版本继承。</p>
              </div>
              <UploadCloud size={22} aria-hidden="true" />
            </div>
            <div className="project-runtime-summary grid min-w-0 grid-cols-2 gap-3">
              <RuntimeAssetSummary
                label="JDK"
                asset={configuration.jdkAsset}
                disabled={pending || !canManage}
                onDelete={() => void deleteAsset("jdk")}
              />
              <RuntimeAssetSummary
                label="依赖包"
                asset={configuration.jarBundleAsset}
                disabled={pending || !canManage}
                onDelete={() => void deleteAsset("jar-bundle")}
              />
            </div>
            {configuration.inheritedFromProjectVersionId ? (
              <p className={cn("settings-note", uiPatterns["settings-note"])}>
                资源继承自 {versionName(structure, configuration.inheritedFromProjectVersionId)}
              </p>
            ) : null}
            {runtimeSourceVersions.length ? (
              <form
                className={cn(
                  "project-runtime-inherit",
                  projectStructureManagerStyles["project-runtime-inherit"],
                )}
                onSubmit={inheritRuntime}
              >
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
            <div
              className={cn(
                "settings-paired-forms",
                projectStructureManagerStyles["settings-paired-forms"],
              )}
            >
              <Disclosure
                header={<>上传本地压缩包</>}
                className={cn(
                  "management-disclosure",
                  projectStructureManagerStyles["management-disclosure"],
                )}
              >
                <form
                  className={cn(
                    "settings-grid-form settings-subform project-structure-subform",
                    uiPatterns["settings-grid-form"],
                    "content-start gap-3",
                  )}
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
                  <label className="col-span-full">
                    本地文件
                    <FileInput
                      name="file"
                      accept=".zip,.tar.gz,.tgz"
                      disabled={!canManage || pending || !selectedVersionId}
                    />
                  </label>
                  <div className="col-span-full flex justify-end border-t border-border pt-3">
                    <Button
                      variant="primary"
                      disabled={pending || !canManage || !selectedVersionId}
                      type="submit"
                    >
                      上传并启用
                    </Button>
                  </div>
                  {runtimeUploadProgress ? (
                    <div
                      className={cn(
                        "project-runtime-upload-progress",
                        projectStructureManagerStyles["project-runtime-upload-progress"],
                      )}
                    >
                      <OperationProgress
                        detail={runtimeUploadProgress.detail}
                        label={runtimeUploadProgress.label}
                        value={runtimeUploadProgress.percent}
                      />
                    </div>
                  ) : null}
                </form>
              </Disclosure>
              <Disclosure
                header={<>登记内网资源链接</>}
                className={cn(
                  "management-disclosure",
                  projectStructureManagerStyles["management-disclosure"],
                )}
              >
                <form
                  className={cn(
                    "settings-grid-form settings-subform project-structure-subform",
                    uiPatterns["settings-grid-form"],
                    "content-start gap-3",
                  )}
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
                  <label className="col-span-full">
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
                    大小（字节）
                    <Input
                      name="sizeBytes"
                      type="number"
                      min={1}
                      required
                      disabled={!canManage || pending || !selectedVersionId}
                    />
                  </label>
                  <label className="col-span-full">
                    SHA-256
                    <Input
                      name="sha256"
                      minLength={64}
                      maxLength={64}
                      required
                      disabled={!canManage || pending || !selectedVersionId}
                    />
                  </label>
                  <div className="col-span-full flex justify-end border-t border-border pt-3">
                    <Button
                      variant="primary"
                      disabled={pending || !canManage || !selectedVersionId}
                      type="submit"
                    >
                      登记链接并启用
                    </Button>
                  </div>
                </form>
              </Disclosure>
            </div>
          </Card>
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

function RuntimeAssetSummary({
  label,
  asset,
  disabled,
  onDelete,
}: {
  label: string;
  asset: ProjectRuntimeAsset | undefined;
  disabled: boolean;
  onDelete: () => void;
}) {
  return (
    <section
      aria-label={`当前${label}`}
      className="grid min-w-0 content-start gap-2 rounded-lg border border-border bg-muted/30 p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">{label}</strong>
        {asset ? (
          <Button
            type="button"
            variant="danger"
            size="compact"
            disabled={disabled}
            onClick={onDelete}
            aria-label={`删除当前${label === "JDK" ? " JDK" : label}`}
          >
            <Trash2 size={14} aria-hidden="true" /> 删除
          </Button>
        ) : (
          <Tag className="m-0">未配置</Tag>
        )}
      </div>
      <p className="m-0 min-w-0 text-sm [overflow-wrap:anywhere]" title={asset?.fileName}>
        {asset?.fileName ?? (label === "JDK" ? "尚未设置 JDK 压缩包" : "尚未设置依赖 JAR 压缩包")}
      </p>
      {asset ? (
        <p className="m-0 text-xs text-muted-foreground">
          {asset.sourceType === "upload" ? "本地上传" : "内网链接"} · {asset.archiveFormat} ·{" "}
          {formatBytes(asset.sizeBytes)}
        </p>
      ) : null}
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

const projectStructureManagerStyles = {
  "action-dialog-form": "mt-0",
  "management-disclosure":
    "min-w-0 rounded-lg border border-border p-3 [&_.ui-disclosure-label]:font-semibold [&_.ui-disclosure-body]:pt-3",
  "project-runtime-inherit":
    "flex min-w-0 flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/30 p-3 [&_label]:grid [&_label]:min-w-0 [&_label]:flex-1 [&_label]:gap-2 [&_label]:text-sm [&_label]:font-medium",
  "project-runtime-upload-progress": "col-span-full",
  "project-stage-list": "max-h-52 overflow-y-auto border-t border-border",
  "project-stage-row":
    "grid grid-cols-[minmax(100px,_1fr)_minmax(0,_2fr)] gap-3 border-b border-border py-2 text-sm [&_strong]:min-w-0 [&_strong]:truncate [&_>_span]:text-muted-foreground [&_>_span]:[overflow-wrap:anywhere]",
  "project-structure-manager": "min-w-0",
  "project-structure-workspace":
    "grid grid-cols-[224px_minmax(0,_1fr)] items-start gap-4 max-[1280px]:grid-cols-[184px_minmax(0,_1fr)] max-[1280px]:gap-3",
  "project-version-detail": "grid min-w-0 gap-4",
  "project-version-navigation": "grid min-w-0 gap-3 rounded-xl border border-border bg-card p-3",
  "project-version-navigation-heading":
    "flex items-center justify-between text-sm [&_>_span]:rounded-full [&_>_span]:bg-muted [&_>_span]:px-2 [&_>_span]:py-1 [&_>_span]:text-xs [&_>_span]:text-muted-foreground",
  "project-version-option":
    "h-auto w-full min-w-0 justify-start rounded-lg border border-transparent bg-muted/40 px-3 py-2.5 text-foreground shadow-none hover:border-border hover:bg-muted [&[aria-pressed=true]]:border-primary/30 [&[aria-pressed=true]]:bg-primary/10 [&[aria-pressed=true]_strong]:font-semibold [&[aria-pressed=true]_strong]:text-primary-text",
  "project-version-options":
    "relative grid max-h-[clamp(192px,_calc(100dvh_-_416px),_480px)] content-start gap-3 overflow-y-auto p-1",
  "settings-paired-forms": "grid min-w-0 grid-cols-2 items-start gap-4 max-[1280px]:grid-cols-1",
} as const;
