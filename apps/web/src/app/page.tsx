import {
  Activity,
  ArrowRight,
  BookOpenText,
  Box,
  CheckCircle2,
  CircleDashed,
  FileArchive,
  Server,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";

import { getPlatformServices } from "@/lib/services";
import { requirePagePermission } from "@/lib/auth";
import {
  isActiveRunBatch,
  runBatchCompletionPercent,
  runBatchStatusLabel,
} from "@/lib/run-batch-presentation";

export const dynamic = "force-dynamic";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default async function DashboardPage() {
  const identity = await requirePagePermission("case.read");
  const services = await getPlatformServices();
  const { catalog, config } = services;
  let runProjectIds: string[] | undefined = [];
  try {
    runProjectIds = services.identityAccess.projectScope(identity, "run.read");
  } catch {
    // The dashboard remains useful to asset-only roles without exposing execution data.
  }
  const [summary, recentSources, runners, recentBatches] = await Promise.all([
    catalog.getDashboardSummary(),
    catalog.listRecentSources(5),
    services.runnerControl.list(),
    services.runBatches.list(5, runProjectIds),
  ]);
  const onlineRunners = runners.filter((runner) => runner.state === "online").length;
  const busyRunners = runners.filter((runner) => runner.busySlots > 0).length;
  const enabledRate =
    summary.methodCount === 0
      ? 0
      : Math.round((summary.enabledMethodCount / summary.methodCount) * 1000) / 10;
  const activeBatch = recentBatches.find((batch) => isActiveRunBatch(batch.status));
  const activeBatchCompletedRuns = activeBatch
    ? activeBatch.succeededRuns +
      activeBatch.failedRuns +
      activeBatch.timedOutRuns +
      activeBatch.cancelledRuns
    : 0;

  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">AutoForge · {config.mode === "lite" ? "Lite" : "Full"}</span>
          <h1>自动化用例工作台</h1>
          <p>从 TestNG JAR 发现测试类，构建可追踪、可执行的用例资产。</p>
        </div>
        <Link className="button button-primary button-large" href="/cases/import">
          <FileArchive size={18} aria-hidden="true" /> 导入 TestNG JAR
        </Link>
      </section>

      <section className="bento-grid" aria-label="平台概览">
        <article className="card bento-quality">
          <div className="card-heading compact">
            <div>
              <span className="eyebrow">当前资产</span>
              <h2>用例发现概览</h2>
            </div>
            <span className="soft-icon blue">
              <Sparkles size={19} />
            </span>
          </div>
          <div className="quality-value">
            <strong>{summary.caseCount}</strong>
            <span>个 TestNG 测试类</span>
          </div>
          <div className="mini-chart" aria-label={`已启用测试方法占比 ${enabledRate}%`}>
            <div className="mini-chart-line" style={{ width: `${Math.max(enabledRate, 2)}%` }} />
          </div>
          <div className="metric-strip">
            <div>
              <span>JAR 来源</span>
              <strong>{summary.sourceCount}</strong>
            </div>
            <div>
              <span>测试方法</span>
              <strong>{summary.methodCount}</strong>
            </div>
            <div>
              <span>已启用</span>
              <strong>{summary.enabledMethodCount}</strong>
            </div>
            <div>
              <span>启用占比</span>
              <strong>{enabledRate}%</strong>
            </div>
          </div>
        </article>

        <article className="card bento-active">
          <div className="card-heading compact">
            <div>
              <span className="eyebrow">执行</span>
              <h2>活动执行</h2>
            </div>
            <Link className="text-link" href="/run-batches">
              查看全部
            </Link>
          </div>
          {activeBatch ? (
            <div className="dashboard-batch">
              <div className="dashboard-batch-title">
                <span className={`batch-status batch-status-${activeBatch.status}`}>
                  {runBatchStatusLabel(activeBatch.status)}
                </span>
                <span>
                  <strong>{activeBatch.suiteName}</strong>
                  <small>
                    任务 v{activeBatch.suiteVersion} · {activeBatch.selectedRunnerIds.length}{" "}
                    台执行机
                  </small>
                </span>
              </div>
              <div className="dashboard-batch-progress">
                <strong>{runBatchCompletionPercent(activeBatch)}%</strong>
                <span>
                  已完成 {activeBatchCompletedRuns} / {activeBatch.totalRuns}
                </span>
              </div>
              <div className="batch-progress-line">
                <span style={{ width: `${runBatchCompletionPercent(activeBatch)}%` }} />
              </div>
              <div className="batch-counts">
                <span>执行中 {activeBatch.runningRuns}</span>
                <span>已完成 {activeBatchCompletedRuns}</span>
                <span>
                  待执行{" "}
                  {Math.max(
                    0,
                    activeBatch.totalRuns - activeBatch.runningRuns - activeBatchCompletedRuns,
                  )}
                </span>
              </div>
            </div>
          ) : (
            <div className="empty-state compact-empty">
              <span className="empty-icon">
                <Activity size={24} />
              </span>
              <strong>当前没有活动批次</strong>
              <p>从用例批跑选择任务与执行机，即可创建可追踪的执行分配。</p>
            </div>
          )}
        </article>

        <article className="card bento-library">
          <div className="card-heading compact">
            <div>
              <span className="eyebrow">用例库</span>
              <h2>已发现内容</h2>
            </div>
            <span className="soft-icon violet">
              <BookOpenText size={19} />
            </span>
          </div>
          <dl className="stat-list">
            <div>
              <dt>
                <Box size={15} /> JAR 包
              </dt>
              <dd>{summary.sourceCount}</dd>
            </div>
            <div>
              <dt>
                <BookOpenText size={15} /> 测试类
              </dt>
              <dd>{summary.caseCount}</dd>
            </div>
            <div>
              <dt>
                <CheckCircle2 size={15} /> 测试方法
              </dt>
              <dd>{summary.methodCount}</dd>
            </div>
          </dl>
          <Link className="text-link" href="/cases">
            打开用例库 <ArrowRight size={15} />
          </Link>
        </article>

        <article className="card bento-runners">
          <div className="card-heading compact">
            <div>
              <span className="eyebrow">执行资源</span>
              <h2>执行机群</h2>
            </div>
            <span className="soft-icon green">
              <Server size={19} />
            </span>
          </div>
          <div className="runner-zero">
            <div className="runner-orbit">
              <Server size={28} />
              <span>{runners.length}</span>
            </div>
            <div>
              <strong>
                {runners.length === 0 ? "尚未注册执行机" : `${onlineRunners} 台执行机在线`}
              </strong>
              <p>
                {runners.length === 0
                  ? "启动 Runner Agent 后会通过 HTTPS 控制协议接入。"
                  : "心跳状态与容量信息已同步到控制台。"}
              </p>
            </div>
          </div>
          <div className="runner-summary">
            <span>
              <i className="dot green-dot" /> 在线 {onlineRunners}
            </span>
            <span>
              <i className="dot amber-dot" /> 繁忙 {busyRunners}
            </span>
            <span>
              <i className="dot gray-dot" /> 离线 {runners.length - onlineRunners}
            </span>
          </div>
          <Link className="text-link" href="/runners">
            管理执行机 <ArrowRight size={15} />
          </Link>
        </article>

        <article className="card bento-insight">
          <div className="card-heading compact">
            <div>
              <span className="eyebrow">发现质量</span>
              <h2>导入状态</h2>
            </div>
            <span className="soft-icon amber">
              <CircleDashed size={19} />
            </span>
          </div>
          {summary.methodCount === 0 ? (
            <div className="empty-state compact-empty">
              <span className="empty-icon">
                <FileArchive size={24} />
              </span>
              <strong>等待首个 JAR</strong>
              <p>上传包含 TestNG `@Test` 注解的测试 JAR 开始构建用例库。</p>
            </div>
          ) : (
            <div className="donut-layout">
              <div
                className="donut"
                style={{ "--donut-value": `${enabledRate * 3.6}deg` } as CSSProperties}
              >
                <span>
                  <strong>{enabledRate}%</strong>
                  <small>已启用</small>
                </span>
              </div>
              <div className="donut-legend">
                <span>
                  <i className="dot green-dot" /> 已启用 {summary.enabledMethodCount}
                </span>
                <span>
                  <i className="dot gray-dot" /> 已禁用{" "}
                  {summary.methodCount - summary.enabledMethodCount}
                </span>
              </div>
            </div>
          )}
        </article>

        <article className="card bento-recent">
          <div className="card-heading compact">
            <div>
              <span className="eyebrow">最近动态</span>
              <h2>JAR 导入记录</h2>
            </div>
            {recentSources.length > 0 && (
              <Link className="text-link" href="/cases">
                查看全部
              </Link>
            )}
          </div>
          {recentSources.length === 0 ? (
            <div className="empty-state compact-empty">
              <span className="empty-icon">
                <FileArchive size={24} />
              </span>
              <strong>暂无导入记录</strong>
              <p>导入后会在这里展示来源、类数量和扫描时间。</p>
            </div>
          ) : (
            <div className="activity-list">
              {recentSources.map((source) => (
                <div className="activity-row" key={source.id}>
                  <span className="activity-icon">
                    <FileArchive size={16} />
                  </span>
                  <span>
                    <strong>{source.displayName}</strong>
                    <small>
                      {source.classCount} 个类 · {source.methodCount} 个方法
                    </small>
                  </span>
                  <time dateTime={source.createdAt}>{formatDate(source.createdAt)}</time>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </div>
  );
}
