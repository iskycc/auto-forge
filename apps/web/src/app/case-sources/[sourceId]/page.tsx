import { Badge } from "@/components/ui/badge";
import { Disclosure } from "@/components/ui/disclosure";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { sourcePreviewSchema } from "@autoforge/contracts";
import { ReadModelStatusBar } from "@/components/read-model-status";
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
  const services = await getPlatformServices();
  const source = await services.caseSources.getSummary(sourceId, projectIds);
  const projection = await services.readModels.read({
    kind: "source_preview",
    projectId: source.projectId,
    sourceId,
  });
  const inspection = projection.payload ? sourcePreviewSchema.parse(projection.payload) : null;
  if (!inspection)
    return (
      <div
        className={cn(
          "page-stack narrow-page",
          uiPatterns["page-stack"],
          uiPatterns["narrow-page"],
        )}
      >
        <section className={cn("page-hero", uiPatterns["page-hero"])}>
          <div>
            <Link className={cn("back-link", pageStyles["back-link"])} href="/objects">
              文件与来源
            </Link>
            <h1>{source.originalFileName}</h1>
            <p>
              {source.classCount} 个测试类 · {source.methodCount} 个方法
            </p>
          </div>
        </section>
        <ReadModelStatusBar snapshots={[projection.status]} />
      </div>
    );
  const canManage = hasPermission(identity, "case_source.manage", source.projectId);
  return (
    <div
      className={cn("page-stack narrow-page", uiPatterns["page-stack"], uiPatterns["narrow-page"])}
    >
      <ReadModelStatusBar snapshots={[projection.status]} />
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <Link className={cn("back-link", pageStyles["back-link"])} href="/objects">
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
      <Card
        as="section"
        className={cn(
          "card source-summary-card",
          uiPatterns["card"],
          pageStyles["source-summary-card"],
        )}
      >
        <div className={cn("source-meta-grid", pageStyles["source-meta-grid"])}>
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
      </Card>
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
        <Card
          as="section"
          className={cn(
            "card source-summary-card",
            uiPatterns["card"],
            pageStyles["source-summary-card"],
          )}
        >
          <div className={cn("card-heading", uiPatterns["card-heading"])}>
            <div>
              <span className={cn("eyebrow", uiPatterns["eyebrow"])}>testng.xml</span>
              <h2>{inspection.testNgXml.suiteName}</h2>
            </div>
          </div>
          <div className={cn("source-meta-grid", pageStyles["source-meta-grid"])}>
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
            <div className={cn("method-list", pageStyles["method-list"])}>
              {Object.entries(inspection.testNgXml.parameters).map(([name, value]) => (
                <div className={cn("method-row", pageStyles["method-row"])} key={name}>
                  <code>{name}</code>
                  <span className={cn("method-descriptor", pageStyles["method-descriptor"])}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      {inspection.warnings.length > 0 && (
        <div className={cn("warning-list", pageStyles["warning-list"])}>
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
      <Card
        as="section"
        className={cn("card inspection-card", uiPatterns["card"], pageStyles["inspection-card"])}
      >
        <div className={cn("card-heading", uiPatterns["card-heading"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>持久化预览</span>
            <h2>测试类与方法</h2>
          </div>
          <Archive size={22} />
        </div>
        {inspection.testClassCount > CLASS_PREVIEW_LIMIT ? (
          <div
            className={cn("implementation-notice", pageStyles["implementation-notice"])}
            role="status"
          >
            共识别 {inspection.testClassCount} 个测试类，超过 {CLASS_PREVIEW_LIMIT}{" "}
            个不再逐条展示；识别异常见上方扫描警告。
          </div>
        ) : (
          <div className={cn("class-preview-list", pageStyles["class-preview-list"])}>
            {uniqueInspectionClasses(inspection.classes).map((candidate) => (
              <Disclosure
                header={
                  <>
                    <span className={cn("class-icon", pageStyles["class-icon"])}>
                      <Archive size={16} />
                    </span>
                    <span className={cn("class-title", pageStyles["class-title"])}>
                      <strong>{candidate.simpleName}</strong>
                      <small>{candidate.className}</small>
                    </span>
                    <span className={cn("method-count", pageStyles["method-count"])}>
                      {candidate.methods.length} 个方法
                    </span>
                    {candidate.source ? (
                      <Badge className={cn("tag", uiPatterns["tag"])}>用例详情可查看源码</Badge>
                    ) : null}
                  </>
                }
                className={cn("class-preview", pageStyles["class-preview"])}
                key={candidate.className}
                defaultOpen={inspection.classes.length <= 5}
              >
                <div className={cn("method-list", pageStyles["method-list"])}>
                  {candidate.parameters && Object.keys(candidate.parameters).length > 0 && (
                    <div className={cn("method-row", pageStyles["method-row"])}>
                      <span className={cn("method-origin", pageStyles["method-origin"])}>参数</span>
                      <code>
                        {Object.entries(candidate.parameters)
                          .map(([name, value]) => `${name}=${value}`)
                          .join("，")}
                      </code>
                    </div>
                  )}
                  {candidate.methods.map((method) => (
                    <div
                      className={cn("method-row", pageStyles["method-row"])}
                      key={`${method.methodName}${method.descriptor}`}
                    >
                      <CheckCircle2
                        size={14}
                        className={
                          method.enabled
                            ? cn("text-success", pageStyles["text-success"])
                            : cn("muted", uiPatterns["muted"])
                        }
                      />
                      <code>{method.methodName}</code>
                      <span className={cn("method-signature", pageStyles["method-signature"])}>
                        {formatMethodSignature(method.descriptor)}
                      </span>
                      <span className={cn("method-origin", pageStyles["method-origin"])}>
                        {method.annotationSource === "class" ? "类级 @Test" : "方法级 @Test"}
                      </span>
                    </div>
                  ))}
                </div>
              </Disclosure>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const pageStyles = {
  "back-link":
    "text-muted-foreground font-semibold inline-flex items-center gap-1.5 mb-[5px] text-sm w-fit [&:hover]:[text-decoration:underline]",
  "class-icon": "grid w-8 h-8 place-items-center rounded-lg bg-muted text-info",
  "class-preview":
    "shrink-0 overflow-hidden border border-solid border-border rounded-lg bg-card [&_.ui-disclosure-label]:grid [&_.ui-disclosure-label]:min-h-15.5 [&_.ui-disclosure-label]:grid-cols-[34px_minmax(0,_1fr)_auto_20px] [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-2.5 [&_.ui-disclosure-label]:py-2.5 [&_.ui-disclosure-label]:px-[13px] [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:[list-style:none] [&_.ui-disclosure-label::-webkit-details-marker]:hidden [&_.ui-disclosure-label:hover]:bg-muted [&[data-open=true]_.summary-chevron]:[transform:rotate(90deg)]",
  "class-preview-list": "flex max-h-[520px] flex-col gap-2 overflow-auto pr-[3px]",
  "class-title":
    "flex min-w-0 flex-col gap-[3px] [&_strong]:text-sm [&_small]:overflow-hidden [&_small]:text-muted-foreground [&_small]:font-mono [&_small]:text-xs [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
  "implementation-notice":
    "mt-4 rounded-lg bg-warning/10 text-warning py-[11px] px-3 text-xs leading-[1.5]",
  "inspection-card": "p-5.5",
  "method-count": "text-muted-foreground text-xs whitespace-nowrap",
  "method-descriptor": "max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap",
  "method-list": "[padding:0_13px_10px_57px]",
  "method-origin": "ml-auto whitespace-nowrap",
  "method-row":
    "flex min-h-9 items-center gap-2 border-t border-solid border-border text-muted-foreground text-xs [&_code]:text-foreground [&_code]:text-xs [&_code]:font-semibold",
  "method-signature":
    "max-w-[340px] overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground text-xs",
  "source-meta-grid":
    "grid grid-cols-[1.4fr_2fr_0.8fr_1fr] gap-px overflow-hidden border border-solid border-border rounded-lg bg-border [&_>_div]:flex [&_>_div]:min-w-0 [&_>_div]:flex-col [&_>_div]:gap-[7px] [&_>_div]:p-[13px] [&_>_div]:bg-muted [&_>_div:last-child:nth-child(4n_+_1)]:col-span-full [&_>_div:last-child:nth-child(4n_+_2)]:[grid-column:span_3] [&_>_div:last-child:nth-child(4n_+_3)]:[grid-column:span_2] [&_span]:text-muted-foreground [&_span]:text-xs [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-normal [&_strong]:text-xs [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal",
  "source-summary-card": "p-4.5",
  "text-success": "text-success",
  "warning-list":
    "flex flex-col gap-[7px] mb-4 rounded-lg p-3 bg-warning/10 text-destructive text-xs [&_>_div]:flex [&_>_div]:items-start [&_>_div]:gap-[7px]",
} as const;
