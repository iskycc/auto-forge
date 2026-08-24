import { hasPermission, isDomainError } from "@autoforge/domain";
import { AlertCircle, ArrowLeft, FileCode2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CaseDefinitionEditor } from "@/components/case-definition-editor";
import { CasePermanentShare } from "@/components/case-permanent-share";
import { CaseVersionHistory } from "@/components/case-version-history";
import { StatusBadge } from "@/components/status-badge";
import { OpenRunDialogButton } from "@/components/global-run-dialog";
import { requirePageProjectScope } from "@/lib/auth";
import { formatMethodSignature } from "@/lib/jvm-signature";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

type CaseDetailPageProps = {
  params: Promise<{ caseId: string }>;
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function executionStatusLabel(status: string): string {
  return (
    {
      queued: "等待资源",
      assigned: "已分配",
      running: "执行中",
      succeeded: "成功",
      failed: "失败",
      timed_out: "超时",
      cancelled: "已取消",
    }[status] ?? "未知状态"
  );
}

function resultCodeLabel(code: string | undefined): string {
  if (!code) return "—";
  return (
    {
      succeeded: "成功",
      failed: "失败",
      skipped: "跳过",
      timed_out: "超时",
      cancelled: "已取消",
      TESTNG_SUCCEEDED: "TestNG 通过",
      TESTNG_SUCCEEDED_WITH_SKIPS: "TestNG 通过（含跳过）",
      TESTNG_ASSERTIONS_FAILED: "TestNG 断言失败",
      TESTNG_CONFIGURATION_FAILED: "TestNG 配置失败",
      TESTNG_EXIT_NONZERO: "TestNG 异常退出",
      TESTNG_FAILURE: "TestNG 执行失败",
      TESTNG_NO_TESTS: "未发现 TestNG 测试",
      ADAPTER_CASE_TIMEOUT: "Adapter 用例超时",
      EXECUTION_TIMEOUT: "执行超时",
      EXECUTION_CANCELLED: "执行已取消",
      CANCELLED_BY_CONTROL_PLANE: "由控制面取消",
      ASSIGNMENT_CLAIM_TIMEOUT: "执行机领取超时",
      LEASE_EXPIRED: "执行租约已过期",
      PROCESS_START_FAILED: "进程启动失败",
      RESOURCE_MEMORY_EXCEEDED: "超出内存限制",
      AGENT_RESTARTED_DURING_EXECUTION: "执行期间 Agent 重启",
      BATCH_TERMINATED_BEFORE_EXECUTION: "执行前批次已终止",
      OK: "成功",
      PASSED: "通过",
      TEST_ASSERTION_FAILED: "测试断言失败",
    }[code] ?? "其他结果"
  );
}

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const { identity, projectIds } = await requirePageProjectScope("case.read");
  const { caseId } = await params;
  const services = await getPlatformServices();
  let definition;
  let versions;
  let activity;
  try {
    definition = await services.caseDefinitions.get(caseId, projectIds);
    versions = await services.caseDefinitions.listVersions(caseId, projectIds);
    activity = await services.caseDefinitions.listActivity(caseId, projectIds);
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
  const canReadSource = hasPermission(identity, "case_source.read", definition.projectId);
  const runnerDirectory = new Map(
    hasPermission(identity, "runner.read")
      ? (await services.runnerControl.list(500)).map((runner) => [runner.id, runner.name] as const)
      : [],
  );
  const sourceRecord = await services.caseSources.get(definition.sourceId, projectIds);
  const executable = sourceRecord.inspection.executable !== false;
  let sourceView: Awaited<ReturnType<typeof services.caseSources.readClassSource>> = null;
  let sourceViewError: string | undefined;
  try {
    sourceView = await services.caseSources.readClassSource(
      definition.sourceId,
      definition.className,
      projectIds,
    );
  } catch (error) {
    sourceViewError = error instanceof Error ? error.message : "源码读取失败。";
  }

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
            <strong>{formatDate(definition.updatedAt)}</strong>
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

      <section className="card table-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Execution history</span>
            <h2>执行历史（{activity.executions.length}）</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>状态</th>
                <th>结果</th>
                <th>Runner</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {activity.executions.length === 0 ? (
                <tr>
                  <td colSpan={5}>当前用例尚无执行记录。</td>
                </tr>
              ) : null}
              {activity.executions.map((execution) => (
                <tr key={execution.runId}>
                  <td>{formatDate(execution.finishedAt ?? execution.createdAt)}</td>
                  <td>{executionStatusLabel(execution.status)}</td>
                  <td title={execution.resultCode}>{resultCodeLabel(execution.resultCode)}</td>
                  <td title={execution.runnerId}>
                    {execution.runnerId
                      ? (runnerDirectory.get(execution.runnerId) ?? execution.runnerId.slice(0, 8))
                      : "—"}
                  </td>
                  <td>
                    <Link href={`/run-batches/${encodeURIComponent(execution.batchId)}`}>
                      查看批次
                    </Link>
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
            <span className="eyebrow">Analysis history</span>
            <h2>分析历史（{activity.analyses.length}）</h2>
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
                  <td colSpan={4}>当前用例尚无分析事实。</td>
                </tr>
              ) : null}
              {activity.analyses.map((analysis) => (
                <tr key={analysis.attemptId}>
                  <td>{formatDate(analysis.completedAt)}</td>
                  <td title={analysis.resultCode ?? analysis.outcome}>
                    {resultCodeLabel(analysis.resultCode ?? analysis.outcome)}
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

      {sourceView ? (
        <section className="card source-code-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Java Source</span>
              <h2>用例源码</h2>
              <p>{sourceView.reference.entryPath}</p>
            </div>
            <FileCode2 size={22} aria-hidden="true" />
          </div>
          <pre className="source-code-viewer" tabIndex={0}>
            <code>{sourceView.content}</code>
          </pre>
        </section>
      ) : sourceViewError ? (
        <div className="alert alert-error" role="alert">
          <AlertCircle size={17} aria-hidden="true" />
          <span>{sourceViewError}</span>
        </div>
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
