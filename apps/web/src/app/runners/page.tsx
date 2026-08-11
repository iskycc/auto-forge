import { Clock3, Server, ShieldCheck } from "lucide-react";
import { assessRunnerCompatibility, hasPermission, type RunBatch } from "@autoforge/domain";

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
      <section className="card table-card">
        {runners.length === 0 ? (
          <div className="empty-state table-empty">
            <span className="empty-icon">
              <Server size={26} />
            </span>
            <strong>尚未注册执行机</strong>
            <p>在上方填写执行机连接信息并完成自动安装后，Agent 会自动注册并出现在这里。</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>执行机</th>
                  <th>平台</th>
                  <th>兼容性</th>
                  <th>容量</th>
                  <th>资源</th>
                  <th>状态</th>
                  <th>最近心跳</th>
                  <th>Lease / 最近任务</th>
                  <th>终端</th>
                  {canManage ? <th>操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {runners.map((runner) => {
                  const compatibility = assessRunnerCompatibility(runner);
                  return (
                    <tr key={runner.id}>
                      <td>
                        <span className="class-cell">
                          <strong>{runner.name}</strong>
                          <small>{runner.labels.join(" · ") || "无标签"}</small>
                          <small title={runner.capabilities.join(", ")}>
                            {runner.capabilities.join(" · ") || "未声明能力"}
                          </small>
                        </span>
                      </td>
                      <td>
                        {runner.os} · {runner.architecture}
                        <br />
                        <small className="muted">
                          Agent {runner.agentVersion} · 协议 v{runner.protocolVersion}
                        </small>
                      </td>
                      <td>
                        <span
                          className={`runner-state runner-compatibility-${compatibility.status}`}
                          title={runnerCompatibilitySummary(compatibility)}
                        >
                          <i /> {runnerCompatibilityLabel(compatibility.status)}
                        </span>
                        <br />
                        <small className="muted">{runnerToolchainSummary(compatibility)}</small>
                      </td>
                      <td>
                        {runner.busySlots} / {runner.maxConcurrency}
                      </td>
                      <td>
                        {runner.resourceSnapshot ? (
                          <span className="runner-resource-cell">
                            <small>CPU {runner.resourceSnapshot.cpuUtilizationPercent}%</small>
                            <small>内存 {runner.resourceSnapshot.memoryUtilizationPercent}%</small>
                            <small>
                              负载/CPU{" "}
                              {(
                                runner.resourceSnapshot.loadAverage1m /
                                runner.resourceSnapshot.logicalCpuCount
                              ).toFixed(2)}
                            </small>
                          </span>
                        ) : (
                          <span className="muted">等待上报</span>
                        )}
                      </td>
                      <td>
                        <span className={`runner-state runner-state-${runner.state}`}>
                          <i />
                          {runner.deregisteredAt
                            ? "已注销"
                            : runner.state === "online"
                              ? "在线"
                              : runner.state === "draining"
                                ? "排空中"
                                : runner.state === "disabled"
                                  ? "已禁用"
                                  : "离线"}
                        </span>
                        {runner.credentialRevokedAt && !runner.deregisteredAt ? (
                          <>
                            <br />
                            <small className="muted">凭据已撤销</small>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <time dateTime={runner.lastSeenAt}>{formatDate(runner.lastSeenAt)}</time>
                      </td>
                      <td>
                        <span className="class-cell">
                          <strong>
                            {runner.busySlots > 0
                              ? `${runner.busySlots} 个活跃槽位`
                              : "无活跃 Lease"}
                          </strong>
                          <small>{recentBatchLabel(recentBatches, runner.id)}</small>
                        </span>
                      </td>
                      <td>
                        <RunnerTerminal
                          runnerId={runner.id}
                          runnerName={runner.name}
                          platformEnabled={Boolean(services.config.terminalAccessToken)}
                          runnerEnabled={runner.terminalEnabled}
                          runnerOnline={runner.state === "online" && !runner.deregisteredAt}
                        />
                      </td>
                      {canManage ? (
                        <td>
                          <RunnerAdminActions
                            runnerId={runner.id}
                            runnerName={runner.name}
                            credentialRevoked={Boolean(runner.credentialRevokedAt)}
                            credentialRotationRequested={Boolean(
                              runner.credentialRotationRequestedAt,
                            )}
                            deregistered={Boolean(runner.deregisteredAt)}
                            state={runner.state}
                          />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function recentBatchLabel(batches: RunBatch[], runnerId: string): string {
  const batch = batches.find((candidate) => candidate.selectedRunnerIds.includes(runnerId));
  return batch ? `${batch.suiteName} · ${batch.status}` : "暂无可见任务";
}
