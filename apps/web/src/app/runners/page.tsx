import { Clock3, Server, ShieldCheck } from "lucide-react";
import {
  assessRunnerCompatibility,
  hasPermission,
  isAgentUpdateAvailable,
  type RunBatch,
  type Runner,
} from "@autoforge/domain";

import { RunnerAdminActions } from "@/components/runner-admin-actions";
import { RunnerAgentInstaller } from "@/components/runner-agent-installer";
import { RunnerTerminal } from "@/components/runner-terminal";
import { RunnerUpdateDialog } from "@/components/runner-update-dialog";
import { RunnerGroupManager } from "@/components/runner-group-manager";
import { BatchRunnerUpdate } from "@/components/batch-runner-update";
import { SectionTabs } from "@/components/section-tabs";
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

export default async function RunnersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requirePagePermission("runner.read");
  const canManage = hasPermission(identity, "runner.manage");
  const services = await getPlatformServices();
  const parameters = await searchParams;
  const activeSection = parameters.section === "groups" ? "groups" : "runners";
  const [runners, runnerGroups] = await Promise.all([
    services.runnerControl.list(500),
    services.runnerGroups.list(),
  ]);
  if (activeSection === "groups") {
    return (
      <div className="page-stack">
        <section className="page-hero">
          <div>
            <span className="eyebrow">Runner Groups</span>
            <h1>执行机组</h1>
            <p>按机房、网络或能力组合执行机；发起任务批跑和单用例执行时可直接选择整组。</p>
          </div>
          <span className="storage-pill">{runnerGroups.length} 个资源组</span>
        </section>
        <SectionTabs
          label="执行资源视图"
          tabs={[
            { href: "/runners", label: "执行机", active: false },
            { href: "/runners?section=groups", label: "执行机组", active: true },
          ]}
        />
        <RunnerGroupManager canManage={canManage} initialGroups={runnerGroups} runners={runners} />
      </div>
    );
  }
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
  // 内置 Agent 资源在 dev 环境可能未构建，此时静默隐藏更新提示。
  const bundledAgentVersion = await services.runnerAgentResources.version().catch(() => undefined);
  const installationProfiles = canManage
    ? await (async () => {
        await services.runnerInstallationProfiles.reconcileBindings(runners);
        return services.runnerInstallationProfiles.list();
      })()
    : [];
  const installationProfileByRunnerId = new Map(
    installationProfiles.flatMap((profile) =>
      profile.runnerId ? ([[profile.runnerId, profile]] as const) : [],
    ),
  );
  const updateTargets = bundledAgentVersion
    ? runners
        .filter(
          (runner) =>
            isAgentUpdateAvailable(runner.agentVersion, bundledAgentVersion) &&
            !runner.deregisteredAt,
        )
        .map((runner) => ({
          runnerId: runner.id,
          runnerName: runner.name,
          hasStoredProfile: installationProfileByRunnerId.has(runner.id),
        }))
    : [];
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
      <SectionTabs
        label="执行资源视图"
        tabs={[
          { href: "/runners", label: "执行机", active: true },
          { href: "/runners?section=groups", label: "执行机组", active: false },
        ]}
      />
      {canManage ? (
        <RunnerAgentInstaller
          controlPlaneUrl={services.config.web.publicBaseUrl}
          profiles={installationProfiles}
        />
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
          <div className="button-row">
            {canManage && bundledAgentVersion ? (
              <BatchRunnerUpdate latestVersion={bundledAgentVersion} targets={updateTargets} />
            ) : null}
            <span className="table-count">共 {runners.length} 台</span>
          </div>
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
              const updateAvailable = bundledAgentVersion
                ? isAgentUpdateAvailable(runner.agentVersion, bundledAgentVersion)
                : false;
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
                    {updateAvailable ? (
                      <span className="tag">可更新至 {bundledAgentVersion}</span>
                    ) : null}
                    <RunnerTerminal
                      runnerId={runner.id}
                      runnerName={runner.name}
                      platformEnabled={Boolean(services.config.terminalAccessToken)}
                      runnerEnabled={runner.terminalEnabled}
                      runnerOnline={runner.state === "online" && !runner.deregisteredAt}
                    />
                    {canManage && updateAvailable && !runner.deregisteredAt ? (
                      <RunnerUpdateDialog
                        latestVersion={bundledAgentVersion!}
                        runnerId={runner.id}
                        runnerName={runner.name}
                        {...(installationProfileByRunnerId.get(runner.id)
                          ? { profile: installationProfileByRunnerId.get(runner.id)! }
                          : {})}
                      />
                    ) : null}
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
