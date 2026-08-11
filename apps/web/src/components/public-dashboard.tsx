"use client";

import {
  publicPlatformStatisticsSchema,
  type PublicPlatformStatistics,
} from "@autoforge/contracts";
import {
  Activity,
  ArrowRight,
  BookOpenCheck,
  Boxes,
  CheckCircle2,
  Clock3,
  Cpu,
  Database,
  FileCode2,
  LockKeyhole,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";

export function PublicDashboard({
  initialStatistics,
  setupRequired,
}: {
  initialStatistics: PublicPlatformStatistics;
  setupRequired: boolean;
}) {
  const [statistics, setStatistics] = useState(initialStatistics);
  const [synchronizing, setSynchronizing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const synchronize = async () => {
      if (document.visibilityState !== "visible") return;
      setSynchronizing(true);
      try {
        const response = await fetch("/api/v1/public/statistics", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("公开统计同步失败。");
        setStatistics(publicPlatformStatisticsSchema.parse(await response.json()));
        setSyncFailed(false);
      } catch {
        if (!controller.signal.aborted) setSyncFailed(true);
      } finally {
        if (!controller.signal.aborted) setSynchronizing(false);
      }
    };
    const timer = window.setInterval(() => void synchronize(), statistics.refreshSeconds * 1_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [statistics.refreshSeconds]);

  const enabledRate = percentage(statistics.enabledMethodCount, statistics.methodCount);
  const runnerOnlineRate = percentage(statistics.onlineRunnerCount, statistics.runnerCount);

  return (
    <main className="public-dashboard">
      <header className="public-header">
        <Link className="public-brand" href="/" aria-label="AutoForge 公开首页">
          <span className="public-brand-mark" aria-hidden="true">
            <Sparkles size={20} />
          </span>
          <span>
            <strong>AutoForge</strong>
            <small>Automation Control Plane</small>
          </span>
        </Link>
        <div className="public-header-actions">
          <span className={`public-live-state ${syncFailed ? "is-stale" : ""}`}>
            {synchronizing ? <RefreshCw className="spin" size={14} /> : <Activity size={14} />}
            {syncFailed ? "数据同步暂时中断" : "平台数据实时同步"}
          </span>
          <Link className="button button-secondary" href={setupRequired ? "/setup" : "/login"}>
            <LockKeyhole size={16} /> {setupRequired ? "初始化平台" : "登录控制台"}
          </Link>
        </div>
      </header>

      <section className="public-hero">
        <div className="public-hero-copy">
          <span className="public-kicker">
            <ShieldCheck size={15} /> 离线优先 · 双模式共享核心 · 受控执行
          </span>
          <h1>
            把自动化测试资产与执行资源
            <span>汇聚到一个可信控制面</span>
          </h1>
          <p>
            AutoForge 统一管理 TestNG
            用例、执行策略、Runner、日志与产物。在没有公网和外部服务的环境中，Lite
            模式也能独立完成核心执行闭环。
          </p>
          <div className="public-hero-actions">
            <Link
              className="button button-primary button-large"
              href={setupRequired ? "/setup" : "/login"}
            >
              {setupRequired ? "开始初始化" : "进入管理平台"} <ArrowRight size={17} />
            </Link>
            <span>
              <Clock3 size={15} /> 最近同步 {formatTime(statistics.generatedAt)}
            </span>
          </div>
        </div>

        <div className="public-system-card" aria-label="系统实时状态">
          <div className="public-system-heading">
            <span>
              <i /> System pulse
            </span>
            <small>每 {statistics.refreshSeconds} 秒刷新</small>
          </div>
          <div className="public-system-score">
            <span
              className="public-score-ring"
              style={{ "--score": `${runnerOnlineRate * 3.6}deg` } as CSSProperties}
            >
              <strong>{runnerOnlineRate}%</strong>
              <small>Runner 在线</small>
            </span>
            <div>
              <span>活动批次</span>
              <strong>{statistics.activeBatchCount}</strong>
              <small>{statistics.busyRunnerCount} 台执行机正在工作</small>
            </div>
          </div>
          <div className="public-system-lines" aria-hidden="true">
            {[32, 45, 39, 62, 54, 76, 69, 88, 73, 92, 84, 96].map((height, index) => (
              <i key={`${height}-${index}`} style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>
      </section>

      <section className="public-metrics" aria-label="公开平台统计">
        <Metric
          icon={FileCode2}
          label="测试用例"
          value={statistics.caseCount}
          detail={`${statistics.methodCount} 个测试方法`}
          tone="violet"
        />
        <Metric
          icon={Boxes}
          label="JAR 来源"
          value={statistics.sourceCount}
          detail={`${enabledRate}% 方法已启用`}
          tone="blue"
        />
        <Metric
          icon={Server}
          label="执行机"
          value={statistics.runnerCount}
          detail={`${statistics.onlineRunnerCount} 台在线`}
          tone="green"
        />
        <Metric
          icon={CheckCircle2}
          label="执行成功率"
          value={`${statistics.successRatePercent}%`}
          detail={`${statistics.totalRunCount} 次执行样本`}
          tone="amber"
        />
      </section>

      <section className="public-content-grid">
        <article className="public-panel public-execution-panel">
          <div className="public-panel-heading">
            <div>
              <span className="eyebrow">Execution overview</span>
              <h2>稳定、可恢复的执行链路</h2>
            </div>
            <Cpu size={22} />
          </div>
          <div className="public-execution-summary">
            <div>
              <strong>{statistics.succeededRunCount}</strong>
              <span>成功执行</span>
            </div>
            <div>
              <strong>{statistics.failedRunCount}</strong>
              <span>失败与超时</span>
            </div>
            <div>
              <strong>{statistics.completedBatchCount}</strong>
              <span>已完成批次</span>
            </div>
          </div>
          <div
            className="public-progress-track"
            aria-label={`执行成功率 ${statistics.successRatePercent}%`}
          >
            <span style={{ width: `${statistics.successRatePercent}%` }} />
          </div>
          <p>
            Assignment、lease、日志和完成上报均使用版本条件与幂等语义，网络中断后可以从确认水位继续。
          </p>
        </article>

        <article className="public-panel public-capability-panel">
          <div className="public-panel-heading">
            <div>
              <span className="eyebrow">Platform capabilities</span>
              <h2>面向内网环境的完整能力</h2>
            </div>
            <Database size={22} />
          </div>
          <div className="public-capability-list">
            <Capability
              icon={BookOpenCheck}
              title="版本化用例资产"
              text="静态发现 TestNG JAR，保留来源、版本和不可变执行快照。"
            />
            <Capability
              icon={Server}
              title="集中 Runner 管理"
              text="统一注册、心跳、能力匹配、排空、凭据轮换和受控安装。"
            />
            <Capability
              icon={ShieldCheck}
              title="离线与安全边界"
              text="无 CDN、SaaS 遥测或运行期下载，密文只在有效 lease 下按需注入。"
            />
          </div>
        </article>
      </section>

      <footer className="public-footer">
        <span>AutoForge · 离线优先的自动化用例工厂</span>
        <span>公开页面仅展示脱敏聚合数据</span>
      </footer>
    </main>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof Server;
  label: string;
  value: string | number;
  detail: string;
  tone: string;
}) {
  return (
    <article className="public-metric-card">
      <span className={`public-metric-icon ${tone}`}>
        <Icon size={20} />
      </span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </span>
    </article>
  );
}

function Capability({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Server;
  title: string;
  text: string;
}) {
  return (
    <div className="public-capability-item">
      <span>
        <Icon size={18} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function percentage(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 1_000) / 10;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
