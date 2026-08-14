import { Clock3, Server, ShieldCheck } from "lucide-react";
import {
  assessRunnerCompatibility,
  hasPermission,
  type RunBatch,
  type Runner,
} from "@autoforge/domain";

import { RunnerAdminActions } from "@/components/runner-admin-actions";
import { RunnerAgentInstaller } from "@/components/runner-agent-installer";
import { RunnerTerminal } from "@/components/runner-terminal";
import { getPlatformServices } from "@/lib/services";
import { requirePagePermission } from "@/lib/auth";
import {
  runnerCompatibilityLabel,
  runnerCompatibilitySummary,
  runnerToolchainSummary,
} from "@/lib/runner-compatibility";

export const dynamic = "force-dynamic";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export default async function RunnersPage() {
  const identity = await requirePagePermission("runner.read");
  const canManage = hasPermission(identity, "runner.manage");
  const services = await getPlatformServices();
  const runners = await services.runnerControl.list(500);
  let recentBatches: Awaited<ReturnType<typeof services.runBatches.listPage>>["items"] = [];
  try {
    const projectIds = services.identityAccess.projectScope(identity, "run.read");
    recentBatches = (
      await services.runBatches.listPage({
        limit: 200,
        ...(projectIds ? { projectIds } : {}),
      })
    ).items;
  } catch {
    // Runner operators without run.read can manage node lifecycle without seeing project execution data.
  }
  const onlineCount = runners.filter((runner) => runner.state === "online").length;
  const incompatibleCount = runners.filter(
    (runner) => !assessRunnerCompatibility(runner).compatible,
  ).length;
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Runner Control</span>
          <h1>执行机</h1>
          <p>
            Agent 主动注册并持续上报心跳；45 秒未上报会显示离线。不兼容节点不会获得新任务
            {incompatibleCount > 0
              ? `；当前有 ${incompatibleCount} 台需要通过平台内置 Agent 资源重新安装或升级。`
              : "。"}
          </p>
        </div>
        <span className="storage-pill">
          <span className="live-dot" /> 在线 {onlineCount} / {runners.length}
        </span>
      </section>
      {canManage ? (
        <RunnerAgentInstaller controlPlaneUrl={services.config.web.publicBaseUrl} />
      ) : null}
      <section className="runner-metrics">
        <div className="card">
          <Server size={20} />
          <span>执行机总数</span>
          <strong>{runners.length}</strong>
        </div>
        <div className="card">
          <ShieldCheck size={20} />
          <span>在线节点</span>
          <strong>{onlineCount}</strong>
        </div>
        <div className="card">
          <Clock3 size={20} />
          <span>离线节点</span>
          <strong>{runners.length - onlineCount}</strong>
        </div>
      </section>
      <section className="card runner-list-card">
        <div className="section-title-row">
          <div>
            <span className="eyebrow">Runner inventory</span>
            <h2>执行机列表</h2>
          </div>
          <span className="table-count">共 {runners.length} 台</span>
        </div>
        {runners.length === 0 ? (
          <div className="empty-state table-empty">
            <span className="empty-icon">
              <Server size={26} />
            </span>
            <strong>尚未注册执行机</strong>
            <p>在上方填写执行机连接信息并完成自动安装后，Agent 会自动注册并出现在这里。</p>
          </div>
        ) : (
          <div className="runner-list" role="table" aria-label="执行机列表">
            {runners.map((runner) => {
              const compatibility = assessRunnerCompatibility(runner);
              return (
                <article className="runner-list-item" key={runner.id} role="row">
                  <header className="runner-list-header" role="cell">
                    <span className="runner-list-identity">
                      <Server size={18} aria-hidden="true" />
                      <span>
                        <strong>{runner.name}</strong>
                        <small>{runner.labels.join(" · ") || "无标签"}</small>
                      </span>
                    </span>
                    <span className={`runner-state runner-state-${runner.state}`}>
                      <i /> {runnerStateLabel(runner)}
                    </span>
                  </header>

                  <div className="runner-list-facts">
                    <div role="cell">
                      <span>平台</span>
                      <strong>
                        {runner.os} · {runner.architecture}
                      </strong>
                      <small>
                        Agent {runner.agentVersion} · 协议 v{runner.protocolVersion}
                      </small>
                    </div>
                    <div role="cell">
                      <span>兼容性</span>
                      <strong>
                        <span
                          className={`runner-state runner-compatibility-${compatibility.status}`}
                          title={runnerCompatibilitySummary(compatibility)}
                        >
                          <i /> {runnerCompatibilityLabel(compatibility.status)}
                        </span>
                      </strong>
                      <small>{runnerToolchainSummary(compatibility)}</small>
                    </div>
                    <div role="cell">
                      <span>容量与资源</span>
                      <strong>
                        {runner.busySlots} / {runner.maxConcurrency} 槽位
                      </strong>
                      <small>{runnerResourceSummary(runner)}</small>
                    </div>
                    <div role="cell">
                      <span>最近心跳</span>
                      <strong>
                        <time dateTime={runner.lastSeenAt}>{formatDate(runner.lastSeenAt)}</time>
                      </strong>
                      <small>{recentBatchLabel(recentBatches, runner.id)}</small>
                    </div>
                  </div>

                  <footer className="runner-list-actions" role="cell">
                    <span
                      className="runner-capability-summary"
                      title={runner.capabilities.join(", ")}
                    >
                      {runner.capabilities.join(" · ") || "未声明能力"}
                    </span>
                    {runner.credentialRevokedAt && !runner.deregisteredAt ? (
                      <span className="tag">凭据已撤销</span>
                    ) : null}
                    <RunnerTerminal
                      runnerId={runner.id}
                      runnerName={runner.name}
                      platformEnabled={Boolean(services.config.terminalAccessToken)}
                      runnerEnabled={runner.terminalEnabled}
                      runnerOnline={runner.state === "online" && !runner.deregisteredAt}
                    />
                    {canManage ? (
                      <RunnerAdminActions
                        runnerId={runner.id}
                        runnerName={runner.name}
                        credentialRevoked={Boolean(runner.credentialRevokedAt)}
                        credentialRotationRequested={Boolean(runner.credentialRotationRequestedAt)}
                        deregistered={Boolean(runner.deregisteredAt)}
                        state={runner.state}
                      />
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function runnerStateLabel(runner: Runner): string {
  if (runner.deregisteredAt) return "已注销";
  if (runner.state === "online") return "在线";
  if (runner.state === "draining") return "排空中";
  if (runner.state === "disabled") return "已禁用";
  return "离线";
}

function runnerResourceSummary(runner: Runner): string {
  if (!runner.resourceSnapshot) return "等待资源上报";
  const loadPerCpu =
    runner.resourceSnapshot.loadAverage1m / runner.resourceSnapshot.logicalCpuCount;
  return `CPU ${runner.resourceSnapshot.cpuUtilizationPercent}% · 内存 ${runner.resourceSnapshot.memoryUtilizationPercent}% · 负载/CPU ${loadPerCpu.toFixed(2)}`;
}

function recentBatchLabel(batches: RunBatch[], runnerId: string): string {
  const batch = batches.find((candidate) => candidate.selectedRunnerIds.includes(runnerId));
  return batch ? `${batch.suiteName} · ${batch.status}` : "暂无可见任务";
}
