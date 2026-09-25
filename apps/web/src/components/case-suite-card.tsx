"use client";
import { Notice } from "@/components/ui/notice";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { Badge } from "@/components/ui/badge";

import { Progress } from "@/components/ui/progress";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { CaseSuiteExecutionStatistics } from "@autoforge/contracts";
import type { CaseSuite } from "@autoforge/domain";
import { ArrowRight, ChevronDown, Download, History, Layers3 } from "lucide-react";
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
    <Card
      as="article"
      aria-label={`任务 ${suite.name}`}
      className={cn(
        uiPatterns["card"],
        caseSuiteCardStyles["suite-card"],
        `card suite-card ${suite.status === "archived" ? cn("suite-card-archived", caseSuiteCardStyles["suite-card-archived"]) : ""} ${!suite.enabled ? cn("suite-card-disabled", caseSuiteCardStyles["suite-card-disabled"]) : ""}`,
      ).trim()}
    >
      <Link
        className={cn("suite-card-link", caseSuiteCardStyles["suite-card-link"])}
        href={`/case-suites/${encodeURIComponent(suite.id)}`}
      >
        <span className={cn("suite-icon", caseSuiteCardStyles["suite-icon"])}>
          <Layers3 size={20} />
        </span>
        <span className={cn("suite-copy", caseSuiteCardStyles["suite-copy"])}>
          <span className={cn("suite-title-line", caseSuiteCardStyles["suite-title-line"])}>
            <strong title={suite.name}>{suite.name}</strong>
            <Badge
              className={cn(
                caseSuiteCardStyles["status-badge"],
                `status-badge ${suite.status === "archived" || !suite.enabled ? "warning" : ""}`,
              ).trim()}
            >
              {suite.status === "archived" ? "已归档" : suite.enabled ? "已启用" : "已停用"}
            </Badge>
          </span>
          <small title={suite.description}>{suite.description || "暂无说明"}</small>
          <small>
            v{suite.version} · 更新于{" "}
            <time dateTime={suite.updatedAt} title={suite.updatedAt}>
              {formatLocalDateTime(suite.updatedAt)}
            </time>
          </small>
        </span>
        <span className={cn("suite-count", caseSuiteCardStyles["suite-count"])}>
          <strong>{suite.caseCount.toLocaleString("zh-CN")}</strong>
          <small>个用例</small>
        </span>
        <ArrowRight size={18} className={cn("muted", uiPatterns["muted"])} />
      </Link>

      {canReadExecutions ? (
        <div
          className={cn("suite-statistics", caseSuiteCardStyles["suite-statistics"])}
          aria-label="近 7 天执行统计"
        >
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
          <div
            className={cn(
              "suite-statistics-caption",
              caseSuiteCardStyles["suite-statistics-caption"],
            )}
          >
            <span>
              {statistics?.completedExecutionCount
                ? `已结束 ${statistics.completedExecutionCount} 次 · 均值按已结束批次计算`
                : "暂无已结束执行，均值待统计"}
            </span>
            {passRate === null ? null : (
              <Progress aria-label="近 7 天平均通过率" max={100} value={passRate} tone="success" />
            )}
          </div>
        </div>
      ) : (
        <Notice
          tone="info"
          className={cn(
            "suite-activity-permission",
            caseSuiteCardStyles["suite-activity-permission"],
          )}
        >
          当前账号无执行记录查看权限
        </Notice>
      )}

      <footer className={cn("suite-card-actions", caseSuiteCardStyles["suite-card-actions"])}>
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
            className={cn(
              caseSuiteCardStyles["suite-history-chevron"],
              `suite-history-chevron ${expanded ? "expanded" : ""}`,
            )}
            size={15}
          />
        </Button>
        <Button
          aria-label={`导出 ${suite.name} 用例`}
          className={cn("suite-card-export", caseSuiteCardStyles["suite-card-export"])}
          disabled={exportDisabled}
          onClick={onExport}
          type="button"
          variant="ghost"
        >
          {exporting ? <LoadingIcon size={15} /> : <Download size={15} />}
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
    </Card>
  );
}

const caseSuiteCardStyles = {
  "status-badge":
    "inline-flex w-fit items-center gap-[5px] rounded-full py-[5px] px-2 text-xs font-semibold whitespace-nowrap",
  "suite-activity-permission": "m-0 text-muted-foreground text-xs leading-[1.6] py-4 px-5",
  "suite-card":
    "grid min-w-0 grid-cols-[minmax(0,_1fr)] p-0 overflow-hidden transition-colors duration-150 motion-reduce:transition-none [&:hover]:shadow-xs [:is(&,_.suite-schedule-dialog)_.status-badge]:shrink-0 [:is(&,_.suite-schedule-dialog)_.status-badge]:bg-success/10 [:is(&,_.suite-schedule-dialog)_.status-badge]:text-success [:is(&,_.suite-schedule-dialog)_.status-badge.info]:bg-info/10 [:is(&,_.suite-schedule-dialog)_.status-badge.info]:text-info [:is(&,_.suite-schedule-dialog)_.status-badge.warning]:bg-warning/10 [:is(&,_.suite-schedule-dialog)_.status-badge.warning]:text-warning [:is(&,_.suite-schedule-dialog)_.status-badge.danger]:bg-destructive/10 [:is(&,_.suite-schedule-dialog)_.status-badge.danger]:text-destructive",
  "suite-card-actions":
    "flex items-center gap-2 justify-between border-t border-solid border-border py-2 px-4",
  "suite-card-archived": "bg-muted [&_.suite-icon]:bg-muted [&_.suite-icon]:text-muted-foreground",
  "suite-card-disabled": "bg-muted [&_.suite-icon]:bg-muted [&_.suite-icon]:text-muted-foreground",
  "suite-card-export": "whitespace-nowrap",
  "suite-card-link":
    "grid min-w-0 min-h-23 grid-cols-[44px_minmax(0,_1fr)_auto_20px] items-center gap-3 p-5",
  "suite-copy":
    "flex min-w-0 flex-col gap-[5px] [&_small]:overflow-hidden [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
  "suite-count":
    "flex min-w-0 flex-col gap-[5px] items-end py-0 px-3 [&_small]:overflow-hidden [&_small]:text-muted-foreground [&_small]:text-xs [&_small]:text-ellipsis [&_small]:whitespace-nowrap [&_strong]:text-2xl",
  "suite-history-chevron":
    "transition-colors duration-150 motion-reduce:transition-none [&.expanded]:[transform:rotate(180deg)]",
  "suite-icon": "grid w-10.5 h-10.5 place-items-center rounded-lg bg-info/10 text-info",
  "suite-statistics":
    "[margin:0_20px_16px] border border-solid border-border rounded-lg p-4 bg-muted [&_dl]:grid [&_dl]:grid-cols-3 [&_dl]:gap-3 [&_dl]:m-0 [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:[margin:8px_0_0] [&_dd]:text-2xl [&_dd]:font-semibold [&_dd]:tabular-nums [&_dd_small]:ml-2 [&_dd_small]:text-muted-foreground [&_dd_small]:text-xs [&_dd_small]:font-normal",
  "suite-statistics-caption":
    "flex items-center gap-2 flex-wrap justify-between mt-3 text-muted-foreground text-xs",
  "suite-title-line":
    "flex min-w-0 items-center gap-2 [&_>_strong]:overflow-hidden [&_>_strong]:text-ellipsis [&_>_strong]:whitespace-nowrap",
} as const;
