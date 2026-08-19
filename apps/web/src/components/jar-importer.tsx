"use client";

import { Button, Input, ProgressBar, Select } from "@/components/ui";

import {
  apiErrorSchema,
  jarImportResultSchema,
  jarImportJobSchema,
  jarInspectionSchema,
  type JarImportResult,
  type JarImportJob,
  type JarInspection,
} from "@autoforge/contracts";
import type { ProjectVersion, TestStage } from "@autoforge/domain";
import {
  AlertCircle,
  Archive,
  Check,
  ChevronRight,
  FileArchive,
  LoaderCircle,
  RotateCcw,
  ScanSearch,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";

import { CLASS_PREVIEW_LIMIT, uniqueInspectionClasses } from "@/lib/class-preview";
import { formatMethodSignature } from "@/lib/jvm-signature";

type Phase = "idle" | "inspecting" | "ready" | "importing" | "done";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

async function errorMessage(response: Response): Promise<string> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(payload);
  return parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`;
}

export function JarImporter({
  maxJarBytes,
  projectId: initialProjectId,
  initialProjectVersionId,
  initialTestStageId,
  projects,
  versions,
}: {
  maxJarBytes: number;
  projectId?: string | undefined;
  initialProjectVersionId?: string | undefined;
  initialTestStageId?: string | undefined;
  projects: Array<{ id: string; name: string }>;
  versions: Array<ProjectVersion & { stages: TestStage[] }>;
}) {
  const inputId = useId();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [inspection, setInspection] = useState<JarInspection | null>(null);
  const [result, setResult] = useState<JarImportResult | null>(null);
  const [job, setJob] = useState<JarImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [projectVersionId, setProjectVersionId] = useState(
    versions.some((version) => version.id === initialProjectVersionId)
      ? (initialProjectVersionId ?? "")
      : (versions[0]?.id ?? ""),
  );
  const availableStages = versions.find((version) => version.id === projectVersionId)?.stages ?? [];
  const [testStageId, setTestStageId] = useState(
    availableStages.some((stage) => stage.id === initialTestStageId)
      ? (initialTestStageId ?? "")
      : (availableStages[0]?.id ?? ""),
  );

  const applyJobState = useCallback(
    (updated: JarImportJob): void => {
      setJob(updated);
      if (updated.status === "succeeded") {
        if (updated.result) {
          setResult(jarImportResultSchema.parse(updated.result));
          setError(null);
          setPhase("done");
          router.refresh();
        } else {
          setError("后台导入已结束，但没有返回导入结果，请从来源列表确认状态。");
          setPhase("ready");
        }
      } else if (updated.status === "failed") {
        setError(updated.errorSummary ?? "后台导入失败。");
        setPhase("ready");
      } else if (updated.status === "cancelled") {
        setError("导入任务已取消，可重新发起。");
        setPhase("ready");
      }
    },
    [router],
  );

  function chooseFile(nextFile: File | null): void {
    setFile(nextFile);
    setInspection(null);
    setResult(null);
    setJob(null);
    setError(null);
    setPhase("idle");
  }

  async function sendFile(url: string): Promise<Response> {
    if (!file) throw new Error("请先选择 JAR 文件。");
    const formData = new FormData();
    formData.set("file", file);
    const target = new URL(url, window.location.origin);
    if (projectId) target.searchParams.set("projectId", projectId);
    if (projectVersionId) target.searchParams.set("projectVersionId", projectVersionId);
    if (testStageId) target.searchParams.set("testStageId", testStageId);
    return fetch(`${target.pathname}${target.search}`, { method: "POST", body: formData });
  }

  async function inspectJar(): Promise<void> {
    setError(null);
    setResult(null);
    if (!file) {
      setError("请先选择 JAR 文件。");
      return;
    }
    if (file.size > maxJarBytes) {
      setError(`文件超过 ${formatBytes(maxJarBytes)} 的导入限制。`);
      return;
    }
    setPhase("inspecting");
    try {
      const response = await sendFile("/api/v1/case-sources/jar/inspect");
      if (!response.ok) throw new Error(await errorMessage(response));
      const parsed = jarInspectionSchema.parse(await response.json());
      setInspection(parsed);
      setPhase("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "扫描 JAR 失败。");
      setPhase("idle");
    }
  }

  async function importJar(): Promise<void> {
    if (!file || !inspection || inspection.testClassCount === 0) return;
    setError(null);
    setPhase("importing");
    try {
      const response = await sendFile("/api/v1/case-sources/jar/import");
      if (!response.ok) throw new Error(await errorMessage(response));
      const parsed = jarImportJobSchema.parse(await response.json());
      // Idempotent duplicate imports can return an already-terminal job. Apply
      // that state immediately because no progress poll will run for it. A
      // succeeded job returned directly by POST is a replay of the implicit
      // content-digest idempotency key, so describe the observable operation
      // as a duplicate even though the stored job retains its original result.
      applyJobState(
        parsed.status === "succeeded" && parsed.result
          ? { ...parsed, result: { ...parsed.result, duplicate: true } }
          : parsed,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导入 JAR 失败。");
      setPhase("ready");
    }
  }

  useEffect(() => {
    if (!job || ["succeeded", "failed", "cancelled"].includes(job.status)) return;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/v1/case-sources/jar/imports/${encodeURIComponent(job.id)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(await errorMessage(response));
        const updated = jarImportJobSchema.parse(await response.json());
        applyJobState(updated);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "读取导入进度失败。");
      }
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [applyJobState, job]);

  async function cancelImport(): Promise<void> {
    if (!job) return;
    const response = await fetch(
      `/api/v1/case-sources/jar/imports/${encodeURIComponent(job.id)}/cancel`,
      { method: "POST" },
    );
    if (!response.ok) {
      setError(await errorMessage(response));
      return;
    }
    const updated = jarImportJobSchema.parse(await response.json());
    // A still-queued job transitions straight to cancelled in this response,
    // so the progress poll never observes the transition.
    applyJobState(updated);
  }

  async function retryImport(): Promise<void> {
    if (!job) return;
    setError(null);
    setPhase("importing");
    const response = await fetch(
      `/api/v1/case-sources/jar/imports/${encodeURIComponent(job.id)}/retry`,
      { method: "POST" },
    );
    if (!response.ok) {
      setError(await errorMessage(response));
      setPhase("ready");
      return;
    }
    applyJobState(jarImportJobSchema.parse(await response.json()));
  }

  const busy = phase === "inspecting" || phase === "importing";

  return (
    <div className="import-workspace">
      <section className="card import-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">第 1 步</span>
            <h2>选择测试 JAR 或 sources JAR</h2>
            <p>
              普通 JAR 扫描 class 注解；sources JAR 扫描 Java 源码，仅静态读取且不会编译或执行。
            </p>
          </div>
          <FileArchive size={24} aria-hidden="true" />
        </div>

        {projects.length > 0 ? (
          <label>
            导入项目
            <Select
              disabled={busy}
              onChange={(event) => {
                const nextProjectId = event.target.value;
                setProjectId(nextProjectId);
                router.push(`/cases/import?projectId=${encodeURIComponent(nextProjectId)}`);
              }}
              value={projectId}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </label>
        ) : projectId ? (
          <p className="settings-note">
            目标项目：<code>{projectId}</code>
          </p>
        ) : null}

        <div className="settings-paired-forms">
          <label>
            项目版本
            <Select
              disabled={busy}
              onChange={(event) => {
                const nextVersionId = event.target.value;
                setProjectVersionId(nextVersionId);
                setTestStageId(
                  versions.find((version) => version.id === nextVersionId)?.stages[0]?.id ?? "",
                );
              }}
              value={projectVersionId}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            测试阶段
            <Select
              disabled={busy}
              onChange={(event) => setTestStageId(event.target.value)}
              value={testStageId}
            >
              {availableStages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {versions.length === 0 || availableStages.length === 0 ? (
          <p className="auth-error" role="alert">
            请先在“项目管理 → 执行配置”创建项目版本和测试阶段，再导入用例。
          </p>
        ) : null}

        <label
          className={`file-dropzone ${file ? "file-dropzone-selected" : ""}`}
          htmlFor={inputId}
        >
          <Input
            id={inputId}
            type="file"
            accept=".jar,application/java-archive"
            onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)}
            disabled={busy}
          />
          <span className="upload-icon">
            <UploadCloud size={26} aria-hidden="true" />
          </span>
          {file ? (
            <span className="file-summary">
              <strong>{file.name}</strong>
              <small>{formatBytes(file.size)} · 点击更换文件</small>
            </span>
          ) : (
            <span className="file-summary">
              <strong>点击选择普通 JAR 或 *-sources.jar</strong>
              <small>最大 {formatBytes(maxJarBytes)}，仅接受 .jar</small>
            </span>
          )}
        </label>
        <p className="settings-note">
          管理员可在<Link href="/settings/platform">平台配置</Link>调整 JAR 上传上限；修改后需重启
          Web 和 worker。
        </p>

        <div className="button-row">
          <Button
            className="button button-primary"
            type="button"
            onClick={inspectJar}
            disabled={!file || busy}
          >
            {phase === "inspecting" ? (
              <LoaderCircle className="spin" size={17} aria-hidden="true" />
            ) : (
              <ScanSearch size={17} aria-hidden="true" />
            )}
            {phase === "inspecting" ? "正在扫描" : "扫描测试类"}
          </Button>
          {file && (
            <Button
              className="button button-secondary"
              type="button"
              onClick={() => chooseFile(null)}
              disabled={busy}
            >
              <RotateCcw size={16} aria-hidden="true" /> 重置
            </Button>
          )}
        </div>
      </section>

      {error && (
        <div className="alert alert-error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {job && phase !== "done" ? (
        <section className="card import-progress" aria-live="polite">
          <div>
            <strong>后台导入 · {job.progressPercent}%</strong>
            <span>{importJobStatus(job.status)}</span>
          </div>
          <ProgressBar label="导入进度" max={100} value={job.progressPercent} />
          <div className="button-row">
            {["queued", "running", "cancel_requested"].includes(job.status) ? (
              <Button className="button button-secondary" type="button" onClick={cancelImport}>
                取消导入
              </Button>
            ) : null}
            {job.status === "failed" || job.status === "cancelled" ? (
              <Button className="button button-secondary" type="button" onClick={retryImport}>
                幂等重试
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {inspection && (
        <section className="card inspection-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">第 2 步</span>
              <h2>确认扫描结果</h2>
              <p>结果来自 TestNG `@Test` 类级和方法级注解。</p>
            </div>
            <Archive size={24} aria-hidden="true" />
          </div>

          <div className="inspection-stats">
            <div>
              <strong>{inspection.classFileCount}</strong>
              <span>class 文件</span>
            </div>
            <div>
              <strong>{inspection.javaSourceFileCount ?? 0}</strong>
              <span>Java 源文件</span>
            </div>
            <div>
              <strong>{inspection.testClassCount}</strong>
              <span>测试类</span>
            </div>
            <div>
              <strong>{inspection.testMethodCount}</strong>
              <span>测试方法</span>
            </div>
            <div>
              <strong>{inspection.hasRootTestNgXml ? "有" : "无"}</strong>
              <span>根 testng.xml</span>
            </div>
          </div>

          {inspection.executable === false ? (
            <div className="implementation-notice" role="status">
              这是 sources JAR。导入后可在用例详情查看源码，但不能直接交给 Agent 执行。
            </div>
          ) : (inspection.javaSourceFileCount ?? 0) > 0 ? (
            <div className="implementation-notice" role="status">
              这是混合 JAR。class 用于 Agent 执行，匹配的 Java 源文件可在用例详情中查看。
            </div>
          ) : null}

          {inspection.warnings.length > 0 && (
            <div className="warning-list" aria-label="扫描警告">
              {inspection.warnings.map((warning, index) => (
                <div key={`${warning.code}-${index}`}>
                  <AlertCircle size={15} aria-hidden="true" />
                  <span>
                    {warning.message}
                    {warning.entry ? `（${warning.entry}）` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {inspection.classes.length > CLASS_PREVIEW_LIMIT ? (
            <div className="implementation-notice" role="status">
              共识别 {inspection.classes.length} 个测试类，超过 {CLASS_PREVIEW_LIMIT}{" "}
              个不再逐条展示；导入进度见下方状态，识别异常见上方扫描警告。
            </div>
          ) : (
            <div className="class-preview-list">
              {uniqueInspectionClasses(inspection.classes).map((candidate) => (
                <details
                  className="class-preview"
                  key={candidate.className}
                  open={inspection.classes.length <= 3}
                >
                  <summary>
                    <span className="class-icon">
                      <Archive size={16} aria-hidden="true" />
                    </span>
                    <span className="class-title">
                      <strong>{candidate.simpleName}</strong>
                      <small>{candidate.className}</small>
                    </span>
                    <span className="method-count">{candidate.methods.length} 个方法</span>
                    {candidate.source ? <span className="tag">可查看源码</span> : null}
                    <ChevronRight className="summary-chevron" size={17} aria-hidden="true" />
                  </summary>
                  <div className="method-list">
                    {candidate.methods.length === 0 ? (
                      <p className="empty-inline">类带有 `@Test`，但未发现可导入的 public 方法。</p>
                    ) : (
                      candidate.methods.map((method) => (
                        <div
                          className="method-row"
                          key={`${method.methodName}${method.descriptor}`}
                        >
                          <span
                            className={`method-status ${method.enabled ? "method-enabled" : "method-disabled"}`}
                          />
                          <code>{method.methodName}</code>
                          <span className="method-signature">
                            {formatMethodSignature(method.descriptor)}
                          </span>
                          <span className="method-origin">
                            {method.annotationSource === "class" ? "类级 @Test" : "方法级 @Test"}
                          </span>
                          {method.groups.map((group) => (
                            <span className="tag" key={group}>
                              {group}
                            </span>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}

          <div className="import-confirmation">
            <div>
              <strong>将创建 {inspection.testClassCount} 个用例定义</strong>
              <span>
                JAR 使用 SHA-256 内容寻址保存，重复文件不会重复导入；sources JAR 作为只读源码资产。
              </span>
            </div>
            <Button
              className="button button-primary"
              type="button"
              onClick={importJar}
              disabled={
                busy ||
                inspection.testClassCount === 0 ||
                phase === "done" ||
                !projectVersionId ||
                !testStageId
              }
            >
              {phase === "importing" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Check size={17} />
              )}
              {phase === "importing" ? "正在导入" : "确认导入"}
            </Button>
          </div>
        </section>
      )}

      {result && (
        <div className="alert alert-success" role="status">
          <Check size={18} aria-hidden="true" />
          <span>
            {result.duplicate
              ? "该 JAR 已导入，已返回现有用例。"
              : `已导入 ${result.importedClassCount} 个测试类、${result.importedMethodCount} 个测试方法。`}
          </span>
          <Link
            href={`/cases?${new URLSearchParams({
              projectId,
              ...(projectVersionId ? { projectVersionId } : {}),
              ...(testStageId ? { testStageId } : {}),
            }).toString()}`}
          >
            查看用例管理
          </Link>
        </div>
      )}
    </div>
  );
}

function importJobStatus(status: JarImportJob["status"]): string {
  return {
    queued: "已持久化，等待后台工作器",
    running: "正在执行有界静态发现与目录写入",
    cancel_requested: "已请求取消，将在安全阶段边界停止",
    cancelled: "已取消",
    succeeded: "已完成",
    failed: "失败，保留诊断并可幂等重试",
  }[status];
}
