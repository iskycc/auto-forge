"use client";

import type { CaseSuiteExecutionStatistics } from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { ArrowRight, ChevronDown, Download, History, Layers3, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import { Button } from "@/components/ui";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { CaseSuiteRecentExecutions } from "./case-suite-recent-executions";

const statisticNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

export function CaseSuiteCard({
  suite,
  statistics,
  canReadExecutions,
  exporting,
  exportDisabled,
  onExport,
}: {
  suite: CaseSuite;
  statistics?: CaseSuiteExecutionStatistics | undefined;
  canReadExecutions: boolean;
  exporting: boolean;
  exportDisabled: boolean;
  onExport: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const historyId = useId();
  const projectVersionId = suite.policy.projectVersionId;
  const passRate = statistics?.averagePassRate ?? null;
  const averagePassedCases = statistics?.averagePassedCases ?? null;

  return (
    <article
      aria-label={`任务 ${suite.name}`}
      className={`card suite-card ${suite.status === "archived" ? "suite-card-archived" : ""} ${!suite.enabled ? "suite-card-disabled" : ""}`.trim()}
    >
      <Link className="suite-card-link" href={`/case-suites/${encodeURIComponent(suite.id)}`}>
        <span className="suite-icon">
          <Layers3 size={20} />
        </span>
        <span className="suite-copy">
          <span className="suite-title-line">
            <strong title={suite.name}>{suite.name}</strong>
            <span
              className={`status-badge ${suite.status === "archived" || !suite.enabled ? "warning" : ""}`.trim()}
            >
              {suite.status === "archived" ? "已归档" : suite.enabled ? "已启用" : "已停用"}
            </span>
          </span>
          <small title={suite.description}>{suite.description || "暂无说明"}</small>
          <small>
            v{suite.version} · 更新于{" "}
            <time dateTime={suite.updatedAt} title={suite.updatedAt}>
              {formatLocalDateTime(suite.updatedAt)}
            </time>
          </small>
        </span>
        <span className="suite-count">
          <strong>{suite.caseCount.toLocaleString("zh-CN")}</strong>
          <small>个用例</small>
        </span>
        <ArrowRight size={18} className="muted" />
      </Link>

      {canReadExecutions ? (
        <div className="suite-statistics" aria-label="近 7 天执行统计">
          <dl>
            <div>
              <dt>7 天执行次数</dt>
              <dd>
                {statisticNumber.format(statistics?.executionCount ?? 0)}
                <small>次</small>
              </dd>
            </div>
            <div>
              <dt>平均通过率</dt>
              <dd>
                {passRate === null ? "—" : statisticNumber.format(passRate)}
                {passRate === null ? null : <small>%</small>}
              </dd>
            </div>
            <div>
              <dt>平均通过用例数</dt>
              <dd>
                {averagePassedCases === null ? "—" : statisticNumber.format(averagePassedCases)}
                {averagePassedCases === null ? null : <small>个</small>}
              </dd>
            </div>
          </dl>
          <div className="suite-statistics-caption">
            <span>
              {statistics?.completedExecutionCount
                ? `已结束 ${statistics.completedExecutionCount} 次 · 均值按已结束批次计算`
                : "暂无已结束执行，均值待统计"}
            </span>
            {passRate === null ? null : (
              <progress aria-label="近 7 天平均通过率" max={100} value={passRate} />
            )}
          </div>
        </div>
      ) : (
        <p className="suite-activity-permission">当前账号无执行记录查看权限</p>
      )}

      <footer className="suite-card-actions">
        <Button
          aria-controls={historyId}
          aria-expanded={expanded}
          disabled={!canReadExecutions || !projectVersionId}
          onClick={() => setExpanded((current) => !current)}
          type="button"
          variant="ghost"
        >
          <History size={16} /> 最近执行
          <ChevronDown
            className={`suite-history-chevron ${expanded ? "expanded" : ""}`}
            size={15}
          />
        </Button>
        <Button
          aria-label={`导出 ${suite.name} 用例`}
          className="suite-card-export"
          disabled={exportDisabled}
          onClick={onExport}
          type="button"
          variant="ghost"
        >
          {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
          {exporting ? "导出中" : "导出用例"}
        </Button>
      </footer>
      <div hidden={!expanded} id={historyId}>
        {expanded && projectVersionId ? (
          <CaseSuiteRecentExecutions
            suiteId={suite.id}
            projectId={suite.projectId}
            projectVersionId={projectVersionId}
          />
        ) : null}
      </div>
    </article>
  );
}
