import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

import { CaseDefinitionEditor } from "@/components/case-definition-editor";
import { CaseExecutionHistory } from "@/components/case-execution-history";
import { CaseFailureAnalysisHistory } from "@/components/case-failure-analysis-history";
import { CaseVersionHistory } from "@/components/case-version-history";
import { LazyCaseSource } from "@/components/lazy-case-source";
import { StatusBadge } from "@/components/status-badge";
import type { CaseDetailView } from "@/lib/case-detail-view";
import { caseExecutionResultLabel } from "@/lib/case-execution-presentation";
import { formatMethodSignature } from "@/lib/jvm-signature";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

type Presentation = "page" | "inspector";

function formatDate(value: string, timeZone: string): string {
  return formatPlatformDateTime(value, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CaseDetailContent({
  detail,
  presentation = "page",
  onDefinitionUpdated,
  onVersionsChanged,
  managementActions,
}: {
  detail: CaseDetailView;
  presentation?: Presentation;
  onDefinitionUpdated?(definition: CaseDefinitionWithMethods): void;
  onVersionsChanged?(): void;
  managementActions?: ReactNode;
}) {
  const { definition, activity, timeZone } = detail;
  const inspector = presentation === "inspector";
  return (
    <>
      <section className={`case-definition-summary ${inspector ? "" : "card source-summary-card"}`}>
        <div className={inspector ? "case-inspector-meta" : "source-meta-grid"}>
          <div>
            <span>状态</span>
            <strong>
              <StatusBadge enabled={definition.enabled} />
              {definition.archived ? <span className="tag">已归档</span> : null}
            </strong>
          </div>
          <div>
            <span>包名</span>
            <strong>{definition.packageName || "—"}</strong>
          </div>
          <div>
            <span>版本 / 测试阶段</span>
            <strong>
              {detail.projectVersionName} / {detail.testStageName}
            </strong>
          </div>
          <div>
            <span>分组</span>
            <strong>{definition.groups.join("、") || "—"}</strong>
          </div>
          <div>
            <span>标签</span>
            <strong>{definition.tags.join("、") || "—"}</strong>
          </div>
          <div>
            <span>测试方法</span>
            <strong>{definition.methods.length}</strong>
          </div>
          <div>
            <span>修订</span>
            <strong>r{definition.revision}</strong>
          </div>
          <div>
            <span>最近更新</span>
            <strong>{formatDate(definition.updatedAt, timeZone)}</strong>
          </div>
          <div className={inspector ? "case-inspector-meta-wide" : "source-meta-wide"}>
            <span>参数（只读）</span>
            <strong>
              {Object.entries(definition.parameters)
                .map(([name, value]) => `${name}=${value}`)
                .join("；") || "—"}
            </strong>
          </div>
        </div>
      </section>

      {!detail.executable ? (
        <div className="implementation-notice" role="status">
          <AlertCircle size={17} aria-hidden="true" />
          该用例来自 sources JAR，可查看和管理源码，但不能直接执行；执行时请导入包含 .class 的测试
          JAR。
        </div>
      ) : null}

      <CaseExecutionHistory
        key={`executions:${definition.id}`}
        caseDefinitionId={definition.id}
        initialPage={detail.executionHistory}
        canReadLogs={detail.canReadLogs}
        canCreateRuns={detail.canRun}
        timeZone={timeZone}
      />
      <CaseFailureAnalysisHistory
        key={`analyses:${definition.id}`}
        canReadEvidence={detail.canReadAnalysisEvidence}
        caseDefinitionId={definition.id}
        compact={inspector}
        initialPage={detail.failureAnalysisHistory}
        projectId={definition.projectId}
        timeZone={timeZone}
      />

      <CaseDetailSection
        presentation={presentation}
        title={`执行结果统计历史（最近 ${activity.analyses.length} 条）`}
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>完成时间</th>
                <th>结果</th>
                <th>通过 / 失败 / 跳过</th>
                <th>失败签名</th>
              </tr>
            </thead>
            <tbody>
              {activity.analyses.length === 0 ? (
                <tr>
                  <td colSpan={4}>当前用例尚无执行结果统计。</td>
                </tr>
              ) : null}
              {activity.analyses.map((analysis) => (
                <tr key={analysis.attemptId}>
                  <td>{formatDate(analysis.completedAt, timeZone)}</td>
                  <td>{caseExecutionResultLabel(analysis.resultCode ?? analysis.outcome)}</td>
                  <td>
                    {analysis.passed} / {analysis.failed} / {analysis.skipped}
                  </td>
                  <td>{analysis.failureSignature ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CaseDetailSection>

      {detail.canReadSource ? (
        <LazyCaseSource
          key={definition.id}
          caseDefinitionId={definition.id}
          revision={definition.revision}
        />
      ) : null}

      {detail.canManage ? (
        <CaseDetailSection presentation={presentation} title="用例元数据">
          <CaseDefinitionEditor
            definition={definition}
            {...(onDefinitionUpdated ? { onUpdated: onDefinitionUpdated } : {})}
          />
          {managementActions}
        </CaseDetailSection>
      ) : null}

      <CaseDetailSection
        presentation={presentation}
        title={`测试方法（${definition.methods.length}）`}
        open
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>方法</th>
                <th>方法签名</th>
                <th>分组</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {definition.methods.map((method) => (
                <tr key={method.id}>
                  <td>
                    <strong>{method.methodName}</strong>
                  </td>
                  <td>
                    <span className="method-signature">
                      {formatMethodSignature(method.descriptor)}
                    </span>
                  </td>
                  <td>{method.groups.join("、") || "—"}</td>
                  <td>
                    <StatusBadge enabled={method.enabled} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CaseDetailSection>

      <CaseDetailSection
        presentation={presentation}
        title={`版本历史（${detail.versions.length}）`}
      >
        <CaseVersionHistory
          canManage={detail.canManage}
          canReadSource={detail.canReadSource}
          caseDefinitionId={definition.id}
          currentVersion={definition.currentVersion}
          {...(onVersionsChanged ? { onChanged: onVersionsChanged } : {})}
          versions={detail.versions}
        />
      </CaseDetailSection>
    </>
  );
}

function CaseDetailSection({
  presentation,
  title,
  children,
  open = false,
}: {
  presentation: Presentation;
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  if (presentation === "inspector") {
    return (
      <details className="case-inspector-section" open={open}>
        <summary>{title}</summary>
        {children}
      </details>
    );
  }
  return (
    <section className="card table-card">
      <div className="card-heading">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}
