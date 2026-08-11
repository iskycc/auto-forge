import { DomainError, hasPermission } from "@autoforge/domain";
import { ArrowLeft, FileCode2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CaseDefinitionEditor } from "@/components/case-definition-editor";
import { CaseVersionHistory } from "@/components/case-version-history";
import { StatusBadge } from "@/components/status-badge";
import { SingleCaseRun } from "@/components/single-case-run";
import { requirePagePermission } from "@/lib/auth";
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

export default async function CaseDetailPage({ params }: CaseDetailPageProps) {
  const identity = await requirePagePermission("case.read");
  const { caseId } = await params;
  const services = await getPlatformServices();
  let definition;
  let versions;
  try {
    definition = await services.caseDefinitions.get(caseId);
    versions = await services.caseDefinitions.listVersions(caseId);
  } catch (error) {
    if (error instanceof DomainError && error.code === "CASE_DEFINITION_NOT_FOUND") notFound();
    throw error;
  }
  const canManage = hasPermission(identity, "case.manage");
  const canRun = hasPermission(identity, "run.create", definition.projectId);
  const runners = canRun ? await services.runnerControl.list(200) : [];

  return (
    <div className="page-stack narrow-page">
      <section className="page-hero">
        <div>
          <Link className="back-link" href="/cases">
            <ArrowLeft size={15} aria-hidden="true" /> 返回用例库
          </Link>
          <span className="eyebrow">Case Definition</span>
          <h1>{definition.displayName}</h1>
          <p>
            <code>{definition.className}</code>
          </p>
        </div>
        <span className="storage-pill">
          <FileCode2 size={16} aria-hidden="true" /> 当前版本 v{definition.currentVersion}
        </span>
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
          <div>
            <span>参数</span>
            <strong>
              {Object.entries(definition.parameters)
                .map(([name, value]) => `${name}=${value}`)
                .join("；") || "—"}
            </strong>
          </div>
        </div>
      </section>

      {canRun && definition.enabled && !definition.archived ? (
        <section className="card">
          <SingleCaseRun caseDefinitionId={definition.id} runners={runners} />
        </section>
      ) : null}

      {canManage ? (
        <section className="card">
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
                <th>描述符</th>
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
                    <code>{method.descriptor}</code>
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
        />
      </section>
    </div>
  );
}
