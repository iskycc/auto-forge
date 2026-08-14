"use client";

import type {
  ProjectAdapterConfiguration,
  ProjectRuntimeAsset,
  ProjectStructure,
} from "@autoforge/domain";
import { FolderTree, UploadCloud } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button, Input, Select } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";

export function ProjectStructureManager({
  projectId,
  initialStructure,
  canManage,
}: {
  projectId: string;
  initialStructure: ProjectStructure;
  canManage: boolean;
}) {
  const [structure, setStructure] = useState(initialStructure);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function refresh(success: string): Promise<void> {
    const response = await fetch(`/api/v1/projects/${projectId}/structure`, {
      cache: "no-store",
    });
    const errorMessage = await readApiErrorMessage(response, "刷新项目结构失败。");
    if (errorMessage) throw new Error(errorMessage);
    setStructure((await response.json()) as ProjectStructure);
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
    });
  }

  function registerUrlAsset(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    void run(async () => {
      const asset = (await submitJson(`/api/v1/projects/${projectId}/runtime-assets/url`, "POST", {
        kind: values.get("kind"),
        url: values.get("url"),
        fileName: values.get("fileName"),
        sha256: values.get("sha256"),
        sizeBytes: Number(values.get("sizeBytes")),
        archiveFormat: values.get("archiveFormat"),
      })) as ProjectRuntimeAsset;
      await saveConfiguration(withAsset(structure.adapterConfiguration, asset));
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
    if (!(file instanceof File) || file.size === 0) {
      setError("请选择非空运行时压缩包。");
      return;
    }
    void run(async () => {
      const response = await fetch(
        `/api/v1/projects/${projectId}/runtime-assets/upload?${new URLSearchParams({ kind, archiveFormat })}`,
        {
          method: "POST",
          headers: {
            "content-type": archiveFormat === "zip" ? "application/zip" : "application/gzip",
            "x-autoforge-file-name": encodeURIComponent(file.name),
          },
          body: file,
        },
      );
      const errorMessage = await readApiErrorMessage(response, "上传运行时资源失败。");
      if (errorMessage) throw new Error(errorMessage);
      const asset = (await response.json()) as ProjectRuntimeAsset;
      await saveConfiguration(withAsset(structure.adapterConfiguration, asset));
      form.reset();
      await refresh("运行时资源已上传并设为当前配置。");
    });
  }

  async function saveConfiguration(configuration: ProjectAdapterConfiguration): Promise<void> {
    await submitJson(`/api/v1/projects/${projectId}/adapter-configuration`, "PUT", {
      ...(configuration.jdkAsset ? { jdkAssetId: configuration.jdkAsset.id } : {}),
      ...(configuration.jarBundleAsset
        ? { jarBundleAssetId: configuration.jarBundleAsset.id }
        : {}),
      expectedRevision: structure.adapterConfiguration.revision,
    });
  }

  const configuration = structure.adapterConfiguration;
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
          <FolderTree size={22} aria-hidden="true" />
        </div>
        <div className="settings-paired-forms">
          <form
            className="settings-grid-form settings-subform project-structure-subform"
            onSubmit={createVersion}
          >
            <label>
              版本名称
              <Input name="name" placeholder="例如 2.4.0" required disabled={!canManage} />
            </label>
            <Button className="primary-button" disabled={pending || !canManage} type="submit">
              创建版本
            </Button>
          </form>
          <form
            className="settings-grid-form settings-subform project-structure-subform"
            onSubmit={createStage}
          >
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
        </div>
        <div className="permission-list project-version-list">
          {structure.versions.map((version) => (
            <span key={version.id}>
              <strong>{version.name}</strong>
              {version.stages.length
                ? ` → ${version.stages.map((stage) => stage.name).join("、")}`
                : " → 尚无测试阶段"}
            </span>
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
        <p className="settings-note">
          当前 JDK：{assetSummary(configuration.jdkAsset)}；当前依赖包：
          {assetSummary(configuration.jarBundleAsset)}
        </p>
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
              <Input name="file" type="file" accept=".zip,.tar.gz,.tgz" disabled={!canManage} />
            </label>
            <Button className="primary-button" disabled={pending || !canManage} type="submit">
              上传并启用
            </Button>
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
