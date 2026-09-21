import type { SystemDiagnostic } from "@autoforge/contracts";
import {
  Activity,
  CircleCheck,
  CircleAlert,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  Layers3,
  MemoryStick,
  Server,
} from "lucide-react";
import type { ReactNode } from "react";
import styles from "./system-diagnostics.module.css";

export function DiagnosticPanels({ diagnostic: report }: { diagnostic: SystemDiagnostic }) {
  const dependencies = [
    {
      label: "数据库",
      value: report.database,
      icon: Database,
      advice: "检查数据库地址、凭据、磁盘空间以及数据库服务状态。",
    },
    {
      label: "对象存储",
      value: report.objectStore,
      icon: HardDrive,
      advice: "检查对象目录权限；Full 部署还需确认 MinIO bucket 已创建且凭据有访问权限。",
    },
    {
      label: "任务队列",
      value: report.queue,
      icon: Layers3,
      advice: "检查队列存储与 NATS JetStream 服务状态；修复后手动刷新诊断。",
    },
    {
      label: "缓存",
      value: report.cache,
      icon: MemoryStick,
      advice: "检查缓存服务地址、认证和可用内存；缓存恢复后可从持久数据重建。",
    },
  ];
  const readyCount = dependencies.filter(({ value }) => value.ready).length;
  const unavailable =
    readyCount < dependencies.length || report.clock?.state === "unavailable" || !report.dataDisk;
  const needsAttention = report.recentErrors.length > 0 || unavailable;
  const tone = unavailable ? "danger" : needsAttention ? "warning" : "success";
  const runtime = report.runtime;
  return (
    <>
      <section className={`content-card ${styles.overview}`}>
        <div className={styles.overviewHeading}>
          <span className={`${styles.statusIcon} ${styles[tone]}`}>
            {needsAttention ? <CircleAlert size={25} /> : <CircleCheck size={25} />}
          </span>
          <div>
            <p className="eyebrow">System health</p>
            <h2>
              {unavailable ? "部分检查不可用" : needsAttention ? "有项目需要关注" : "平台运行正常"}
            </h2>
            <p>
              {readyCount} / 4 项依赖就绪 · 本次检查
              {needsAttention ? `发现 ${report.recentErrors.length} 项提示` : "未发现异常"}
            </p>
          </div>
          <span className={`${styles.badge} ${styles[tone]}`}>
            {unavailable ? "检查异常" : needsAttention ? "需要关注" : "健康"}
          </span>
        </div>
        <div className={`diagnostic-summary ${styles.summary}`}>
          <div>
            <small>AutoForge 版本</small>
            <strong>{report.build?.kind === "development" ? "开发构建" : report.version}</strong>
            <small>
              {report.build?.revision
                ? `提交 ${report.build.revision.slice(0, 12)}`
                : "未标记为正式发布版本"}
            </small>
          </div>
          <div>
            <small>部署模式</small>
            <strong>
              {report.mode.toUpperCase()}
              <span>{runtime?.distributed ? "分布式" : "单节点"}</span>
            </strong>
            <small>配置修订 #{report.configurationRevision}</small>
          </div>
          <div>
            <small>Web 进程运行时长</small>
            <strong>{runtime ? uptime(runtime.uptimeSeconds) : "未提供"}</strong>
            <small>
              {runtime
                ? `${runtime.platform} / ${runtime.architecture} · Node.js ${runtime.nodeVersion}`
                : "升级后可读取运行环境"}
            </small>
          </div>
        </div>
      </section>
      {report.recentErrors.length > 0 ? (
        <section className={`content-card ${styles.issues}`} aria-label="诊断提示">
          <h3>
            <CircleAlert size={17} /> 需要关注
          </h3>
          <ul>
            {report.recentErrors.map((issue) => (
              <li key={issue.code}>
                <p className={styles.issueSummary}>{issue.summary}</p>
                {issue.summary.length > 180 ? (
                  <details>
                    <summary>查看完整错误</summary>
                    <p>{issue.summary}</p>
                  </details>
                ) : null}
                <code>{issue.code}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="基础依赖健康" className={`diagnostic-grid ${styles.dependencies}`}>
        {dependencies.map(({ label, value, icon: Icon, advice }) => (
          <article className={`content-card ${styles.dependency}`} key={label}>
            <div className={styles.panelHeading}>
              <Icon size={18} />
              <h3>{label}</h3>
              <span className={`${styles.badge} ${styles[value.ready ? "success" : "danger"]}`}>
                {value.ready ? "就绪" : "异常"}
              </span>
            </div>
            <strong>{value.provider ?? "未提供适配器信息"}</strong>
            <p>{value.ready ? "连接检查通过" : advice}</p>
            {!value.ready ? (
              <details>
                <summary>查看原始诊断</summary>
                <p>{value.detail}</p>
              </details>
            ) : null}
            <small>{value.durationMs === undefined ? "" : `检查耗时 ${value.durationMs} ms`}</small>
          </article>
        ))}
      </section>
      <div className={styles.panels}>
        <NodeBuildPanel report={report} />
        <ResourceCapacityPanel report={report} />
        <QueueSnapshotPanel report={report} />
        <ClockStatusPanel report={report} />
      </div>
    </>
  );
}

function NodeBuildPanel({ report }: { report: SystemDiagnostic }) {
  const runtime = report.runtime;
  return (
    <section className={`content-card ${styles.panel}`} aria-label="节点与构建">
      <PanelHeading icon={<Server size={18} />} title="节点与构建" />
      <dl className={styles.facts}>
        <Fact label="当前响应节点">{runtime?.hostname ?? "未提供"}</Fact>
        <Fact label="节点 ID">
          <code>{runtime?.nodeId ?? "未提供"}</code>
        </Fact>
        <Fact label="发布提交">
          <code>{report.build?.revision ?? "未记录（开发构建）"}</code>
        </Fact>
        <Fact label="构建时间">
          {report.build?.createdAt ? (
            <Timestamp value={report.build.createdAt} />
          ) : (
            "未记录（开发构建）"
          )}
        </Fact>
        <Fact label="后台资源策略">
          <span
            className={`${styles.badge} ${styles[runtime?.backgroundAllowed ? "success" : "warning"]}`}
          >
            {runtime ? (runtime.backgroundAllowed ? "允许后台工作" : "后台工作暂时退让") : "未提供"}
          </span>
        </Fact>
      </dl>
      <p className={styles.note}>
        资源信息仅属于当前响应节点；后台工作根据 Web 和执行负载动态退让。
      </p>
    </section>
  );
}

function ResourceCapacityPanel({ report }: { report: SystemDiagnostic }) {
  const runtime = report.runtime;
  return (
    <section className={`content-card ${styles.panel}`} aria-label="资源与容量">
      <PanelHeading icon={<Cpu size={18} />} title="资源与容量" />
      {runtime ? (
        <>
          <div className={styles.resourceTop}>
            <div>
              <small>有效 CPU 额度</small>
              <strong>
                {Number(runtime.cpuCapacity.toFixed(2))}
                <small> 核</small>
              </strong>
            </div>
            <div>
              <small>内存额度</small>
              <strong>{bytes(runtime.memoryCapacityBytes)}</strong>
            </div>
            <div>
              <small>可用内存</small>
              <strong>{bytes(runtime.availableMemoryBytes)}</strong>
            </div>
          </div>
          <Meter
            label="Web 进程内存（RSS）"
            value={(runtime.processRssBytes / runtime.memoryCapacityBytes) * 100}
            detail={`${bytes(runtime.processRssBytes)} / ${bytes(runtime.memoryCapacityBytes)}`}
          />
          <p className={styles.note}>
            Web 主线程堆 {bytes(runtime.heapUsedBytes)} / {bytes(runtime.heapLimitBytes)}
            ；额度已考虑容器限制。
          </p>
        </>
      ) : (
        <p className={styles.note}>当前版本未提供进程资源数据。</p>
      )}
      {report.dataDisk ? (
        <Meter
          label="平台数据卷"
          value={report.dataDisk.usedPercent}
          detail={`已用 ${report.dataDisk.usedPercent}% · 可用 ${bytes(report.dataDisk.availableBytes)} / ${bytes(report.dataDisk.capacityBytes)}`}
          tone={
            report.dataDisk.status === "ok"
              ? "info"
              : report.dataDisk.status === "warning"
                ? "warning"
                : "danger"
          }
        />
      ) : (
        <p className="form-error">平台数据卷容量读取失败。</p>
      )}
      <p className={styles.note}>
        数据卷为整个文件系统容量，不代表 AutoForge 占用或远端对象存储容量。
      </p>
    </section>
  );
}

function QueueSnapshotPanel({ report }: { report: SystemDiagnostic }) {
  return (
    <section className={`content-card ${styles.panel}`} aria-label="队列快照">
      <PanelHeading icon={<Activity size={18} />} title="队列快照" />
      <div className={styles.queueStats}>
        {[
          { label: "可投递", value: report.queueDepth?.available },
          { label: "已租约", value: report.queueDepth?.leased },
          { label: "死信", value: report.queueDepth?.deadLetter },
        ].map(({ label, value }) => (
          <div key={label}>
            <strong>{value?.toLocaleString("zh-CN") ?? "—"}</strong>
            <small>{label}</small>
          </div>
        ))}
      </div>
      <p className={styles.note}>
        这是队列消息数量，不是执行中的用例数量。死信列表最多展示 20 条，每次最多重新投递 100 条。
      </p>
    </section>
  );
}

function ClockStatusPanel({ report }: { report: SystemDiagnostic }) {
  return (
    <section className={`content-card ${styles.panel}`} aria-label="平台时间基准">
      <PanelHeading icon={<Clock3 size={18} />} title="平台时间基准" />
      {report.clock ? (
        <dl className={styles.facts}>
          <Fact label="统一时间源">
            {report.clock.source === "postgres" ? "共享 PostgreSQL" : "本地单调时钟"}
          </Fact>
          <Fact label="同步状态">
            {report.clock.state === "synchronized"
              ? "正常"
              : report.clock.state === "holdover"
                ? "采样中断，容错计时中"
                : "不可用"}
          </Fact>
          <Fact label="宿主机时间偏差">
            {report.clock.state === "unavailable"
              ? "无法比较"
              : `${report.clock.hostOffsetMs >= 0 ? "+" : ""}${(report.clock.hostOffsetMs / 1000).toFixed(1)} 秒`}
          </Fact>
          <Fact label="最近校准">
            {report.clock.lastSynchronizedAt ? (
              <Timestamp value={report.clock.lastSynchronizedAt} />
            ) : (
              "未记录"
            )}
          </Fact>
        </dl>
      ) : (
        <p className={styles.note}>当前版本未提供时间基准信息。</p>
      )}
    </section>
  );
}

function PanelHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className={styles.panelHeading}>
      {icon}
      <h3>{title}</h3>
    </div>
  );
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
function Timestamp({ value }: { value: string }) {
  return (
    <time dateTime={value} title={`UTC ${value}`}>
      {new Date(value).toLocaleString("zh-CN")}
    </time>
  );
}
function Meter({
  label,
  value,
  detail,
  tone = "info",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "info" | "warning" | "danger";
}) {
  return (
    <div className={styles.meter}>
      <div>
        <span>{label}</span>
        <small>{detail}</small>
      </div>
      <progress
        className={styles[tone]}
        aria-label={label}
        max={100}
        value={Math.min(100, Math.max(0, value))}
      />
    </div>
  );
}
function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days
    ? `${days} 天 ${hours} 小时`
    : hours
      ? `${hours} 小时 ${minutes} 分钟`
      : `${minutes} 分钟`;
}
function bytes(value: number): string {
  return value < 1024 ** 3
    ? `${(value / 1024 ** 2).toFixed(1)} MiB`
    : `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
