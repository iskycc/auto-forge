import { LazyCaseSource } from "@/components/lazy-case-source";
import { failureAnalysisHistoryPageSchema } from "@autoforge/contracts";
import { hasPermission, isDomainError } from "@autoforge/domain";
import { AlertCircle, ArrowLeft, FileCode2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CaseDefinitionEditor } from "@/components/case-definition-editor";
import { CaseExecutionHistory } from "@/components/case-execution-history";
import { CaseFailureAnalysisHistory } from "@/components/case-failure-analysis-history";
import { CasePermanentShare } from "@/components/case-permanent-share";
import { CaseVersionHistory } from "@/components/case-version-history";
import { StatusBadge } from "@/components/status-badge";
import { OpenRunDialogButton } from "@/components/global-run-dialog";
import { requirePageProjectScope } from "@/lib/auth";
import { formatMethodSignature } from "@/lib/jvm-signature";
import { getPlatformServices } from "@/lib/services";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { caseExecutionResultLabel } from "@/lib/case-execution-presentation";

export const dynamic = "force-dynamic";

type CaseDetailPageProps = {
  params: Promise<{ caseId: string }>;
};

function formatDate(value: string, timeZone: string): string {
  return formatPlatformDateTime(value, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const { identity, projectIds } = await requirePageProjectScope("case.read");
  const { caseId } = await params;
  const services = await getPlatformServices();
  const timeZone = services.configurationStore.read().web.timeZone;
  let definition;
  let versions;
  let activity;
  let executionHistory;
  let failureAnalysisHistory;
  try {
    definition = await services.caseDefinitions.get(caseId, projectIds);
    [versions, activity, executionHistory, failureAnalysisHistory] = await Promise.all([
      services.caseDefinitions.listVersions(caseId, projectIds),
      services.caseDefinitions.listActivity(caseId, projectIds),
      services.caseDefinitions.listExecutionHistory(caseId, projectIds, {
        includeRunnerNames: hasPermission(identity, "runner.read"),
      }),
      services.failureAnalysis.listCaseHistory({
        projectId: definition.projectId,
        caseDefinitionId: caseId,
        limit: 20,
      }),
    ]);
  } catch (error) {
    if (isDomainError(error) && error.code === "CASE_DEFINITION_NOT_FOUND") notFound();
    throw error;
  }
  if (!definition.projectVersionId || !definition.testStageId) notFound();
  const structure = await services.projectStructures.list(definition.projectId);
  const projectVersion = structure.versions.find(
    (version) => version.id === definition.projectVersionId,
  );
  const testStage = projectVersion?.stages.find((stage) => stage.id === definition.testStageId);
  if (!projectVersion || !testStage) notFound();
  const canManage = hasPermission(identity, "case.manage", definition.projectId);
  const canRun = hasPermission(identity, "run.create", definition.projectId);
  const canReadLogs = hasPermission(identity, "log.read", definition.projectId);
  const canReadAnalysisEvidence = hasPermission(identity, "run.read", definition.projectId);
  const canReadSource = hasPermission(identity, "case_source.read", definition.projectId);
  const executable = await services.caseSources.executable(definition.sourceId, projectIds);

  return (
    <div className="page-stack case-detail-page">
      <section className="page-hero case-detail-hero">
        <div>
          <Link
            className="back-link"
            href={`/cases?${new URLSearchParams({
              projectId: definition.projectId,
              projectVersionId: projectVersion.id,
              testStageId: testStage.id,
            }).toString()}`}
          >
            <ArrowLeft size={15} aria-hidden="true" /> 返回用例管理
          </Link>
          <span className="eyebrow case-detail-eyebrow">Case Definition</span>
          <h1 title={definition.displayName}>{definition.displayName}</h1>
          <p>
            <code>{definition.className}</code>
          </p>
        </div>
        <div className="case-detail-actions">
          <CasePermanentShare caseDefinitionId={definition.id} />
          {canRun && definition.enabled && !definition.archived && executable ? (
            <OpenRunDialogButton
              caseDefinitionId={definition.id}
              className="button button-primary"
            />
          ) : null}
          <span className="storage-pill">
            <FileCode2 size={16} aria-hidden="true" /> 当前版本 v{definition.currentVersion}
          </span>
        </div>
      </section>

      <section className="card source-summary-card">
        <div className="source-meta-grid">
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
              {projectVersion.name} / {testStage.name}
            </strong>
          </div>
          <div>
            <span>分组</span>
            <strong>{definition.groups.join("、") || "—"}</strong>
          </div>
          <div>
            <span>修订</span>
            <strong>r{definition.revision}</strong>
          </div>
          <div>
            <span>最近更新</span>
            <strong>{formatDate(definition.updatedAt, timeZone)}</strong>
          </div>
          <div className="source-meta-wide">
            <span>参数</span>
            <strong>
              {Object.entries(definition.parameters)
                .map(([name, value]) => `${name}=${value}`)
                .join("；") || "—"}
            </strong>
          </div>
        </div>
      </section>

      {!executable ? (
        <div className="implementation-notice" role="status">
          <AlertCircle size={17} aria-hidden="true" />
          该用例来自 sources JAR，可查看和管理源码，但不能直接执行；执行时请导入包含 .class 的测试
          JAR。
        </div>
      ) : null}

      <CaseExecutionHistory
        caseDefinitionId={definition.id}
        initialPage={executionHistory}
        canReadLogs={canReadLogs}
        canCreateRuns={canRun}
        timeZone={timeZone}
      />

      <CaseFailureAnalysisHistory
        canReadEvidence={canReadAnalysisEvidence}
        caseDefinitionId={definition.id}
        initialPage={failureAnalysisHistoryPageSchema.parse(failureAnalysisHistory)}
        projectId={definition.projectId}
        timeZone={timeZone}
      />

      <section className="card table-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Execution facts</span>
            <h2>执行结果统计历史（{activity.analyses.length}）</h2>
          </div>
        </div>
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
                  <td title={analysis.resultCode ?? analysis.outcome}>
                    {caseExecutionResultLabel(analysis.resultCode ?? analysis.outcome)}
                  </td>
                  <td>
                    {analysis.passed} / {analysis.failed} / {analysis.skipped}
                  </td>
                  <td>{analysis.failureSignature ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canReadSource ? (
        <LazyCaseSource caseDefinitionId={definition.id} revision={definition.revision} />
      ) : null}

      {canManage ? (
        <section className="card case-editor-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">编辑</span>
              <h2>用例元数据</h2>
            </div>
          </div>
          <CaseDefinitionEditor definition={definition} />
        </section>
      ) : null}

      <section className="card table-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">方法</span>
            <h2>测试方法（{definition.methods.length}）</h2>
          </div>
        </div>
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
      </section>

      <section className="card table-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">历史</span>
            <h2>版本历史（{versions.length}）</h2>
          </div>
        </div>
        <CaseVersionHistory
          caseDefinitionId={definition.id}
          versions={versions}
          currentVersion={definition.currentVersion}
          canManage={canManage}
          canReadSource={canReadSource}
        />
      </section>
    </div>
  );
}
