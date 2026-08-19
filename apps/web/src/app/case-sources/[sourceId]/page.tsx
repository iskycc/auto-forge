import { AlertCircle, Archive, ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";

import { SourceActions } from "@/components/source-actions";
import { SourceLifecyclePanel } from "@/components/source-lifecycle";
import { CLASS_PREVIEW_LIMIT, uniqueInspectionClasses } from "@/lib/class-preview";
import { formatMethodSignature } from "@/lib/jvm-signature";
import { getPlatformServices } from "@/lib/services";
import { requirePageProjectScope } from "@/lib/auth";
import { hasPermission } from "@autoforge/domain";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ sourceId: string }> };

export default async function CaseSourcePage({ params }: Props) {
  const { identity, projectIds } = await requirePageProjectScope("case_source.read");
  const { sourceId } = await params;
  const { source, inspection } = await (
    await getPlatformServices()
  ).caseSources.get(sourceId, projectIds);
  const canManage = hasPermission(identity, "case_source.manage", source.projectId);
  return (
    <div className="page-stack narrow-page">
      <section className="page-hero">
        <div>
          <Link className="back-link" href="/objects">
            <ArrowLeft size={15} /> 文件与来源
          </Link>
          <h1>{source.originalFileName}</h1>
          <p>
            {inspection.testClassCount} 个测试类、{inspection.testMethodCount}{" "}
            个测试方法，扫描快照可随时在线查看。
          </p>
        </div>
        {canManage ? (
          <SourceActions sourceId={source.id} authoritative={source.authoritative} />
        ) : null}
      </section>
      <section className="card source-summary-card">
        <div className="source-meta-grid">
          <div>
            <span>对象键</span>
            <code>{source.objectKey}</code>
          </div>
          <div>
            <span>SHA-256</span>
            <code>{source.sha256}</code>
          </div>
          <div>
            <span>文件大小</span>
            <strong>{source.sizeBytes.toLocaleString()} B</strong>
          </div>
          <div>
            <span>扫描模式</span>
            <strong>
              {inspection.discoveryMode === "java-source-annotations"
                ? "Java 源码注解"
                : "class 字节码注解"}
            </strong>
          </div>
          <div>
            <span>执行能力</span>
            <strong>{inspection.executable === false ? "仅源码查看" : "可执行测试 JAR"}</strong>
          </div>
          <div>
            <span>Java 源文件</span>
            <strong>{inspection.javaSourceFileCount ?? 0}</strong>
          </div>
          <div>
            <span>目标 Java 版本</span>
            <strong>{inspection.targetJavaVersion ?? "默认"}</strong>
          </div>
        </div>
      </section>
      {canManage ? (
        <SourceLifecyclePanel
          sourceId={source.id}
          authoritative={source.authoritative}
          status={source.status}
          lifecycleStatus={source.lifecycleStatus}
          revision={source.revision}
        />
      ) : null}
      {inspection.testNgXml && (
        <section className="card source-summary-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">testng.xml</span>
              <h2>{inspection.testNgXml.suiteName}</h2>
            </div>
          </div>
          <div className="source-meta-grid">
            <div>
              <span>test 数量</span>
              <strong>{inspection.testNgXml.testCount}</strong>
            </div>
            <div>
              <span>选中测试类</span>
              <strong>{inspection.testNgXml.selectedClassCount}</strong>
            </div>
          </div>
          {Object.keys(inspection.testNgXml.parameters).length > 0 && (
            <div className="method-list">
              {Object.entries(inspection.testNgXml.parameters).map(([name, value]) => (
                <div className="method-row" key={name}>
                  <code>{name}</code>
                  <span className="method-descriptor">{value}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {inspection.warnings.length > 0 && (
        <div className="warning-list">
          {inspection.warnings.map((warning, index) => (
            <div key={`${warning.code}-${index}`}>
              <AlertCircle size={15} />
              <span>
                {warning.message}
                {warning.entry ? `（${warning.entry}）` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      <section className="card inspection-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">持久化预览</span>
            <h2>测试类与方法</h2>
          </div>
          <Archive size={22} />
        </div>
        {inspection.classes.length > CLASS_PREVIEW_LIMIT ? (
          <div className="implementation-notice" role="status">
            共识别 {inspection.classes.length} 个测试类，超过 {CLASS_PREVIEW_LIMIT}{" "}
            个不再逐条展示；识别异常见上方扫描警告。
          </div>
        ) : (
          <div className="class-preview-list">
            {uniqueInspectionClasses(inspection.classes).map((candidate) => (
              <details
                className="class-preview"
                key={candidate.className}
                open={inspection.classes.length <= 5}
              >
                <summary>
                  <span className="class-icon">
                    <Archive size={16} />
                  </span>
                  <span className="class-title">
                    <strong>{candidate.simpleName}</strong>
                    <small>{candidate.className}</small>
                  </span>
                  <span className="method-count">{candidate.methods.length} 个方法</span>
                  {candidate.source ? <span className="tag">用例详情可查看源码</span> : null}
                </summary>
                <div className="method-list">
                  {candidate.parameters && Object.keys(candidate.parameters).length > 0 && (
                    <div className="method-row">
                      <span className="method-origin">参数</span>
                      <code>
                        {Object.entries(candidate.parameters)
                          .map(([name, value]) => `${name}=${value}`)
                          .join("，")}
                      </code>
                    </div>
                  )}
                  {candidate.methods.map((method) => (
                    <div className="method-row" key={`${method.methodName}${method.descriptor}`}>
                      <CheckCircle2
                        size={14}
                        className={method.enabled ? "text-success" : "muted"}
                      />
                      <code>{method.methodName}</code>
                      <span className="method-signature">
                        {formatMethodSignature(method.descriptor)}
                      </span>
                      <span className="method-origin">
                        {method.annotationSource === "class" ? "类级 @Test" : "方法级 @Test"}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
