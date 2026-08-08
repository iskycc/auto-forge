"use client";

import {
  apiErrorSchema,
  jarImportResultSchema,
  jarInspectionSchema,
  type JarImportResult,
  type JarInspection,
} from "@autoforge/contracts";
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
import { useId, useState } from "react";

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

export function JarImporter({ maxJarBytes }: { maxJarBytes: number }) {
  const inputId = useId();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [inspection, setInspection] = useState<JarInspection | null>(null);
  const [result, setResult] = useState<JarImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function chooseFile(nextFile: File | null): void {
    setFile(nextFile);
    setInspection(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  }

  async function sendFile(url: string): Promise<Response> {
    if (!file) throw new Error("请先选择 JAR 文件。");
    const formData = new FormData();
    formData.set("file", file);
    return fetch(url, { method: "POST", body: formData });
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
      const parsed = jarImportResultSchema.parse(await response.json());
      setResult(parsed);
      setPhase("done");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导入 JAR 失败。");
      setPhase("ready");
    }
  }

  const busy = phase === "inspecting" || phase === "importing";

  return (
    <div className="import-workspace">
      <section className="card import-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">第 1 步</span>
            <h2>选择测试 JAR</h2>
            <p>平台只读取 ZIP 目录和 class 注解，不会加载或运行上传的字节码。</p>
          </div>
          <FileArchive size={24} aria-hidden="true" />
        </div>

        <label
          className={`file-dropzone ${file ? "file-dropzone-selected" : ""}`}
          htmlFor={inputId}
        >
          <input
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
              <strong>点击选择 JAR 文件</strong>
              <small>最大 {formatBytes(maxJarBytes)}，仅接受 .jar</small>
            </span>
          )}
        </label>

        <div className="button-row">
          <button
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
          </button>
          {file && (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => chooseFile(null)}
              disabled={busy}
            >
              <RotateCcw size={16} aria-hidden="true" /> 重置
            </button>
          )}
        </div>
      </section>

      {error && (
        <div className="alert alert-error" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

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

          <div className="class-preview-list">
            {inspection.classes.map((candidate) => (
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
                  <ChevronRight className="summary-chevron" size={17} aria-hidden="true" />
                </summary>
                <div className="method-list">
                  {candidate.methods.length === 0 ? (
                    <p className="empty-inline">类带有 `@Test`，但未发现可导入的 public 方法。</p>
                  ) : (
                    candidate.methods.map((method) => (
                      <div className="method-row" key={`${method.methodName}${method.descriptor}`}>
                        <span
                          className={`method-status ${method.enabled ? "method-enabled" : "method-disabled"}`}
                        />
                        <code>{method.methodName}</code>
                        <span className="method-descriptor">{method.descriptor}</span>
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

          <div className="import-confirmation">
            <div>
              <strong>将创建 {inspection.testClassCount} 个用例定义</strong>
              <span>JAR 使用 SHA-256 内容寻址保存，重复文件不会重复导入。</span>
            </div>
            <button
              className="button button-primary"
              type="button"
              onClick={importJar}
              disabled={busy || inspection.testClassCount === 0 || phase === "done"}
            >
              {phase === "importing" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Check size={17} />
              )}
              {phase === "importing" ? "正在导入" : "确认导入"}
            </button>
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
          <Link href="/cases">查看用例库</Link>
        </div>
      )}
    </div>
  );
}
