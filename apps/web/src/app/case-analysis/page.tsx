import { DEFAULT_PROJECT_ID } from "@autoforge/domain";
import { ArrowRight, CheckCircle2, Clock3, SearchCheck } from "lucide-react";
import Link from "next/link";

import { FailureAnalysisExportButton } from "@/components/failure-analysis-export-button";
import { requireAuthorizedPageProjectScope, requirePageProjectScope } from "@/lib/auth";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { getPlatformServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export default async function CaseAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { identity } = await requirePageProjectScope("run.read");
  const services = await getPlatformServices();
  const parameters = await searchParams;
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId = (await selectedProjectId(identity, projects, "run.read")) ?? DEFAULT_PROJECT_ID;
  requireAuthorizedPageProjectScope(identity, "run.read", projectId);
  const structure = await services.projectStructures.list(projectId);
  const hierarchy = await selectedProjectHierarchy(structure);
  const selectedVersion = structure.versions.find(
    (version) => version.id === hierarchy.projectVersionId,
  );
  const cursor = singleParameter(parameters.cursor);
  const batchPage = hierarchy.projectVersionId
    ? await services.failureAnalysis.listBatches({
        projectId,
        projectVersionId: hierarchy.projectVersionId,
        ...(cursor ? { cursor } : {}),
        limit: 24,
      })
    : { items: [] };

  return (
    <div className="page-stack failure-analysis-page">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Failure Analysis</span>
          <h1>用例分析</h1>
          <p>选择已经执行到终态的任务，只分析该任务最后一轮仍然失败的用例。</p>
        </div>
        <span className="hero-icon violet">
          <SearchCheck size={24} />
        </span>
      </section>
      <section className="card case-scope-toolbar" aria-label="用例分析范围">
        <div className="case-scope-heading">
          <strong>当前分析范围</strong>
          <span>其他轮次、仍在运行以及单用例派生批次都不会进入分析候选。</span>
        </div>
        <div className="case-scope-current">
          <span>
            <small>项目版本</small>
            <strong>{selectedVersion?.name ?? "尚未配置"}</strong>
          </span>
        </div>
      </section>

      {batchPage.items.length === 0 ? (
        <section className="content-card failure-analysis-empty">
          <CheckCircle2 size={26} />
          <strong>当前版本没有待分析的终态任务</strong>
          <span>任务最后一轮出现失败用例后，会显示在这里。</span>
        </section>
      ) : (
        <section className="failure-analysis-batch-grid" aria-label="可分析任务">
          {batchPage.items.map((batch) => (
            <article className="content-card failure-analysis-batch-card" key={batch.id}>
              <div className="failure-analysis-batch-heading">
                <span className="eyebrow">任务 #{batch.sequenceNumber}</span>
                <span className="analysis-status available">终态</span>
              </div>
              <h2>{batch.suiteName}</h2>
              <p>
                <Clock3 size={14} /> {formatPlatformDateTime(batch.createdAt)}
              </p>
              <dl>
                <div className="round-metric">
                  <dt>最终轮次</dt>
                  <dd>第 {batch.currentRound} 轮</dd>
                </div>
                <div className="failure-metric">
                  <dt>最终失败</dt>
                  <dd>{batch.failedRuns}</dd>
                </div>
                <div className="claimed-metric">
                  <dt>已认领</dt>
                  <dd>{batch.claimedRuns}</dd>
                </div>
                <div className="completed-metric">
                  <dt>已完成分析</dt>
                  <dd>{batch.completedRuns}</dd>
                </div>
              </dl>
              <div className="failure-analysis-batch-progress">
                <span>
                  分析进度
                  <strong>
                    {batch.completedRuns} / {batch.failedRuns}
                  </strong>
                </span>
                <progress
                  aria-label={`任务 ${batch.suiteName} 分析进度`}
                  max={Math.max(1, batch.failedRuns)}
                  value={batch.completedRuns}
                />
              </div>
              <div className="failure-analysis-batch-actions">
                <FailureAnalysisExportButton batchId={batch.id} />
                <Link
                  aria-label="查看用例分析详情"
                  className="ui-button ui-button-secondary failure-analysis-batch-link"
                  href={`/case-analysis/${encodeURIComponent(batch.id)}`}
                >
                  进入分析工作台 <ArrowRight size={15} />
                </Link>
              </div>
            </article>
          ))}
        </section>
      )}

      {batchPage.items.length > 0 ? (
        <nav className="failure-analysis-pagination" aria-label="用例分析任务分页">
          <span>本页 {batchPage.items.length} 个任务</span>
          {batchPage.nextCursor ? (
            <Link
              className="ui-button ui-button-secondary"
              href={`/case-analysis?cursor=${encodeURIComponent(batchPage.nextCursor)}`}
            >
              查看更早任务 <ArrowRight size={15} />
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function singleParameter(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
