"use client";

import type { PublicPlatformStatistics } from "@autoforge/contracts";
import {
  ArrowRight,
  BookOpenCheck,
  Boxes,
  CheckCircle2,
  Database,
  FileCode2,
  Fingerprint,
  Layers3,
  LockKeyhole,
  Network,
  Server,
  ShieldCheck,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { PublicControlPreview, publicSnapshotPresentation } from "./public-control-preview";
import { usePublicStatistics } from "./use-public-statistics";
import styles from "./public-dashboard.module.css";

const executionStages = [
  { icon: BookOpenCheck, title: "用例入库", description: "TestNG / DDT 统一管理" },
  { icon: Layers3, title: "任务编排", description: "固化版本与执行策略" },
  { icon: Server, title: "Runner 执行", description: "资源调度与故障恢复" },
  { icon: Fingerprint, title: "结果分析", description: "日志对比与质量洞察" },
] as const;

export function PublicDashboard({
  initialStatistics,
  setupRequired,
}: {
  initialStatistics: PublicPlatformStatistics;
  setupRequired: boolean;
}) {
  const { statistics, synchronizing, syncFailed, refresh } = usePublicStatistics(initialStatistics);
  const { hasStatistics } = publicSnapshotPresentation(statistics, syncFailed);
  const count = (value: number) => (hasStatistics ? value.toLocaleString("zh-CN") : "—");
  const entryHref = setupRequired ? "/setup" : "/login";
  const entryLabel = setupRequired ? "初始化平台" : "登录控制台";

  return (
    <main className={styles.page}>
      <header className={styles.header + " public-header"}>
        <Link className={styles.brand} href="/" aria-label="AutoForge 公开首页">
          <span className={styles.brandMark}>
            <Sparkles aria-hidden="true" size={22} strokeWidth={2} />
          </span>
          <span>
            <strong>AutoForge</strong>
            <small>AUTOMATION CONTROL PLANE</small>
          </span>
        </Link>
        <nav className={styles.navigation} aria-label="公开首页导航">
          <a href="#capabilities">平台能力</a>
          <a href="#architecture">执行链路</a>
          <a href="#deployment">部署方式</a>
        </nav>
        <Link className={"button " + styles.headerEntry} href={entryHref}>
          <LockKeyhole aria-hidden="true" size={15} />
          {entryLabel}
          <ArrowRight aria-hidden="true" size={15} />
        </Link>
      </header>

      <section className={styles.hero + " public-hero"} aria-labelledby="public-heading">
        <div className={styles.heroCopy}>
          <div className={styles.kicker}>
            <span aria-hidden="true" />
            可信控制面 · 离线优先
          </div>
          <h1 id="public-heading">
            <span>让每一次执行，</span>
            <span>
              都可控、<em>可追溯。</em>
            </span>
          </h1>
          <p>
            从用例入库到质量洞察，让自动化测试有序运转。
            <br />
            统一资产、执行与分析，让团队专注于交付质量。
          </p>
          <div className={styles.heroActions}>
            <Link className={"button " + styles.primaryEntry} href={entryHref}>
              {setupRequired ? "开始初始化" : "进入管理平台"}
              <ArrowRight aria-hidden="true" size={17} />
            </Link>
            <a className={"button " + styles.secondaryEntry} href="#capabilities">
              了解平台能力
              <ArrowRight aria-hidden="true" size={16} />
            </a>
          </div>
          <div className={styles.entryHint}>
            <LockKeyhole aria-hidden="true" size={13} />
            {setupRequired
              ? "首次使用 · 创建管理员后即可开始"
              : "使用平台账号登录，进入你的工作空间"}
          </div>
          <div className={styles.trustPoints} aria-label="平台关键保障">
            <span>
              <ShieldCheck aria-hidden="true" size={15} />
              支持离线部署
            </span>
            <span>
              <LockKeyhole aria-hidden="true" size={15} />
              角色权限管控
            </span>
            <span>
              <Fingerprint aria-hidden="true" size={15} />
              执行全程留痕
            </span>
          </div>
        </div>
        <PublicControlPreview
          statistics={statistics}
          syncFailed={syncFailed}
          synchronizing={synchronizing}
          onRefresh={refresh}
        />
      </section>

      <section className={styles.metrics} aria-label="公开平台统计">
        <Metric
          icon={FileCode2}
          label="TestNG 用例"
          value={count(statistics.caseCount)}
          detail="纳管的测试类资产"
        />
        <Metric
          icon={BookOpenCheck}
          label="测试方法"
          value={count(statistics.methodCount)}
          detail={
            hasStatistics ? count(statistics.enabledMethodCount) + " 个已启用" : "等待统计快照"
          }
        />
        <Metric
          icon={Boxes}
          label="JAR 来源"
          value={count(statistics.sourceCount)}
          detail="可追溯的用例来源"
        />
        <Metric
          icon={Workflow}
          label="累计执行"
          value={count(statistics.totalRunCount)}
          detail={
            hasStatistics
              ? statistics.runnerCount === 0
                ? "尚未接入执行机"
                : count(statistics.runnerCount) + " 台执行机已接入"
              : "等待统计快照"
          }
        />
      </section>

      <section className={styles.capabilities} id="capabilities" aria-label="AutoForge 核心能力">
        <div className={styles.sectionHeading}>
          <div>
            <small>BUILT FOR YOUR WORKFLOW</small>
            <h2>从用例资产，到质量结论。</h2>
          </div>
          <p>每个环节紧密衔接，每次执行有据可查。</p>
        </div>
        <div className={styles.capabilityGrid}>
          <CapabilityCard
            number="01"
            icon={BookOpenCheck}
            tone="brand"
            title="统一用例资产"
            text="TestNG 与 DDT 在同一工作台管理。按项目、版本和测试阶段组织用例，变更有历史，执行有快照。"
            points={["TestNG / DDT", "版本历史", "执行快照"]}
          />
          <CapabilityCard
            number="02"
            icon={Workflow}
            tone="info"
            title="可靠执行链路"
            text="将策略交给任务，将执行交给 Runner。从资源调度到中断恢复，日志、结果与产物始终关联。"
            points={["批量编排", "中断恢复", "日志对比"]}
          />
          <CapabilityCard
            number="03"
            icon={ShieldCheck}
            tone="success"
            title="清晰的安全边界"
            text="角色决定权限，项目隔离访问范围。平台支持离线运行，Runner 通过受控协议连接控制面。"
            points={["RBAC 权限", "操作审计", "离线运行"]}
          />
        </div>
        <section className={styles.executionFlow} id="architecture" aria-label="自动化执行链路">
          <ol>
            {executionStages.map(({ icon: Icon, title, description }, index) => (
              <li key={title}>
                <span className={styles.stageIcon}>
                  <Icon aria-hidden="true" size={18} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </div>
                {index < executionStages.length - 1 && (
                  <ArrowRight className={styles.stageArrow} aria-hidden="true" size={16} />
                )}
              </li>
            ))}
          </ol>
        </section>
      </section>

      <section className={styles.deployment} id="deployment" aria-label="部署与运行保障">
        <div className={styles.deploymentIntro}>
          <small>DEPLOY YOUR WAY</small>
          <h2>轻装起步，从容扩展。</h2>
          <p>两种部署形态，同一套操作体验。</p>
        </div>
        <article>
          <span className={styles.deploymentIcon}>
            <Database aria-hidden="true" size={22} />
          </span>
          <div>
            <h3>
              Lite <small>单机部署</small>
            </h3>
            <p>SQLite 与本地存储，无外部服务依赖。</p>
          </div>
        </article>
        <article>
          <span className={styles.deploymentIcon}>
            <Network aria-hidden="true" size={22} />
          </span>
          <div>
            <h3>
              Full <small>集群部署</small>
            </h3>
            <p>独立扩展 Web、调度器与工作器。</p>
          </div>
        </article>
      </section>

      <footer className={styles.footer + " public-footer"}>
        <span>
          <strong>AutoForge</strong>让自动化执行，更进一步。
        </span>
        <span>
          <ShieldCheck aria-hidden="true" size={14} />
          公开页面仅展示脱敏聚合数据
        </span>
      </footer>
    </main>
  );
}

function Metric({
  detail,
  icon: Icon,
  label,
  value,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <article className={styles.metric}>
      <div>
        <span className={styles.metricIcon}>
          <Icon aria-hidden="true" size={17} />
        </span>
        <h2>{label}</h2>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function CapabilityCard({
  number,
  icon: Icon,
  tone,
  title,
  text,
  points,
}: {
  number: string;
  icon: LucideIcon;
  tone: string;
  title: string;
  text: string;
  points: readonly string[];
}) {
  return (
    <article className={styles.capability} data-tone={tone}>
      <div className={styles.capabilityTop}>
        <span>
          <Icon aria-hidden="true" size={23} />
        </span>
        <small>{number}</small>
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      <ul>
        {points.map((point) => (
          <li key={point}>
            <CheckCircle2 aria-hidden="true" size={13} />
            {point}
          </li>
        ))}
      </ul>
    </article>
  );
}
