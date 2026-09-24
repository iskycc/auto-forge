import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { Clock3, Search, Server, ShieldCheck } from "lucide-react";
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
import { getPlatformServices } from "@/lib/services";
import { requirePagePermission } from "@/lib/auth";
import {
  selectableProjectIds,
  selectedProjectHierarchy,
  selectedProjectId,
} from "@/lib/selected-project";
import { runBatchStatusLabel } from "@/lib/run-batch-presentation";
import { Button, Input, Select } from "@/components/ui";
import Link from "next/link";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { runnerControlPlaneUrl } from "@/lib/platform-configuration";

export const dynamic = "force-dynamic";

function formatDate(value: string, timeZone: string): string {
  return formatPlatformDateTime(value, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default async function RunnersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const identity = await requirePagePermission("runner.read");
  const canManage = hasPermission(identity, "runner.manage");
  const services = await getPlatformServices();
  const timeZone = services.configurationStore.read().web.timeZone;
  const parameters = await searchParams;
  const activeSection = parameters.section === "groups" ? "groups" : "runners";
  const [runners, runnerGroups] = await Promise.all([
    services.runnerControl.list(500),
    services.runnerGroups.list(),
  ]);
  if (activeSection === "groups") {
    return (
      <div className={cn("page-stack", uiPatterns["page-stack"])}>
        <section className={cn("page-hero", uiPatterns["page-hero"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Runner Groups</span>
            <h1>执行机组</h1>
            <p>按机房、网络或能力组合执行机；发起任务批跑和单用例执行时可直接选择整组。</p>
          </div>
          <span className={cn("storage-pill", pageStyles["storage-pill"])}>
            {runnerGroups.length} 个资源组
          </span>
        </section>
        <RunnerGroupManager canManage={canManage} initialGroups={runnerGroups} runners={runners} />
      </div>
    );
  }
  let recentBatches: Awaited<ReturnType<typeof services.runBatches.listMetadataPage>>["items"] = [];
  try {
    const projects = await services.identities.listProjects(selectableProjectIds(identity));
    const projectId = await selectedProjectId(identity, projects, "run.read");
    if (projectId && hasPermission(identity, "run.read", projectId)) {
      const hierarchy = await selectedProjectHierarchy(
        await services.projectStructures.list(projectId),
      );
      recentBatches = hierarchy.projectVersionId
        ? (
            await services.runBatches.listMetadataPage({
              limit: 200,
              projectId,
              projectIds: [projectId],
              projectVersionId: hierarchy.projectVersionId,
            })
          ).items
        : [];
    }
  } catch {
    // Runner operators without run.read can manage node lifecycle without seeing project execution data.
  }
  const onlineCount = runners.filter((runner) => runner.state === "online").length;
  const runnerQuery = singleParameter(parameters.query).toLocaleLowerCase("zh-CN");
  const runnerState = runnerStateParameter(parameters.state);
  const filteredRunners = runners.filter(
    (runner) =>
      (!runnerState || runner.state === runnerState) &&
      (!runnerQuery ||
        `${runner.name} ${runner.id} ${runner.labels.join(" ")}`
          .toLocaleLowerCase("zh-CN")
          .includes(runnerQuery)),
  );
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(filteredRunners.length / pageSize));
  const currentPage = Math.min(pageCount, positiveInteger(parameters.page));
  const visibleRunners = filteredRunners.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
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
    <div
      className={cn(
        uiPatterns["page-stack"],
        "page-stack runner-page",
        runners.length > 0 && cn("has-runners", pageStyles["has-runners"]),
      )}
    >
      <section className={cn("page-hero", uiPatterns["page-hero"])}>
        <div>
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Runner Control</span>
          <h1>执行节点</h1>
          <p>
            Agent 主动注册并持续上报心跳；45 秒未上报会显示离线。不兼容节点不会获得新任务
            {incompatibleCount > 0
              ? `；当前有 ${incompatibleCount} 台需要通过平台内置 Agent 资源重新安装或升级。`
              : "。"}
          </p>
        </div>
        <span className={cn("storage-pill", pageStyles["storage-pill"])}>
          <span className={cn("live-dot", pageStyles["live-dot"])} /> 在线 {onlineCount} /{" "}
          {runners.length}
        </span>
      </section>
      {canManage ? (
        <RunnerAgentInstaller
          controlPlaneUrl={runnerControlPlaneUrl(services.configurationStore.read().web)}
          linkedRunners={runners.map((runner) => ({
            id: runner.id,
            labels: runner.labels,
            maxConcurrency: runner.maxConcurrency,
            name: runner.name,
            terminalEnabled: runner.terminalEnabled,
          }))}
          profiles={installationProfiles}
        />
      ) : null}
      <section className={cn("runner-metrics", pageStyles["runner-metrics"])}>
        <Card as="div" className={cn("card", uiPatterns["card"])}>
          <Server size={20} />
          <span>执行机总数</span>
          <strong>{runners.length}</strong>
        </Card>
        <Card as="div" className={cn("card", uiPatterns["card"])}>
          <ShieldCheck size={20} />
          <span>在线节点</span>
          <strong>{onlineCount}</strong>
        </Card>
        <Card as="div" className={cn("card", uiPatterns["card"])}>
          <Clock3 size={20} />
          <span>离线节点</span>
          <strong>{runners.length - onlineCount}</strong>
        </Card>
      </section>
      <Card
        as="section"
        className={cn("card runner-list-card", uiPatterns["card"], pageStyles["runner-list-card"])}
      >
        <div className={cn("section-title-row", uiPatterns["section-title-row"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Runner inventory</span>
            <h2>执行机列表</h2>
          </div>
          <div className={cn("button-row", uiPatterns["button-row"])}>
            {canManage && bundledAgentVersion ? (
              <BatchRunnerUpdate latestVersion={bundledAgentVersion} targets={updateTargets} />
            ) : null}
            <span className={cn("table-count", pageStyles["table-count"])}>
              {filteredRunners.length === runners.length
                ? `共 ${runners.length} 台`
                : `匹配 ${filteredRunners.length} / ${runners.length} 台`}
            </span>
          </div>
        </div>
        <form
          action="/runners"
          className={cn("runner-list-filter", pageStyles["runner-list-filter"])}
          method="get"
        >
          <label>
            搜索执行机
            <Input
              defaultValue={singleParameter(parameters.query)}
              name="query"
              placeholder="名称或标签"
            />
          </label>
          <label>
            状态
            <Select defaultValue={runnerState ?? ""} name="state">
              <option value="">全部状态</option>
              <option value="online">在线</option>
              <option value="offline">离线</option>
              <option value="draining">排空中</option>
              <option value="disabled">已禁用</option>
            </Select>
          </label>
          <Button type="submit" variant="secondary">
            <Search size={16} /> 筛选
          </Button>
        </form>
        {runners.length === 0 ? (
          <EmptyState
            className={cn(
              "empty-state table-empty",
              uiPatterns["empty-state"],
              uiPatterns["table-empty"],
            )}
          >
            <span className={cn("empty-icon", uiPatterns["empty-icon"])}>
              <Server size={26} />
            </span>
            <strong>尚未注册执行机</strong>
            <p>点击上方“打开自动安装”，填写连接信息并完成安装后，Agent 会自动出现在这里。</p>
          </EmptyState>
        ) : visibleRunners.length === 0 ? (
          <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
            没有匹配当前筛选条件的执行机。
          </div>
        ) : (
          <div
            className={cn("runner-list", pageStyles["runner-list"])}
            role="table"
            aria-label="执行机列表"
          >
            {visibleRunners.map((runner) => {
              const updateAvailable = bundledAgentVersion
                ? isAgentUpdateAvailable(runner.agentVersion, bundledAgentVersion)
                : false;
              return (
                <article
                  className={cn("runner-list-item", pageStyles["runner-list-item"])}
                  key={runner.id}
                  role="row"
                >
                  <header
                    className={cn("runner-list-header", pageStyles["runner-list-header"])}
                    role="cell"
                  >
                    <span
                      className={cn("runner-list-identity", pageStyles["runner-list-identity"])}
                    >
                      <Server size={18} aria-hidden="true" />
                      <span>
                        <strong>{runner.name}</strong>
                        <small>{runner.labels.join(" · ") || "无标签"}</small>
                      </span>
                    </span>
                    <span
                      className={cn(
                        pageStyles["runner-state"],
                        `runner-state runner-state runner-state-${runner.state}`,
                      )}
                    >
                      <i /> {runnerStateLabel(runner)}
                    </span>
                  </header>

                  <div className={cn("runner-list-facts", pageStyles["runner-list-facts"])}>
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
                      <span>容量与资源</span>
                      <strong>
                        {runner.busySlots} / {runner.maxConcurrency} 槽位
                      </strong>
                      <small>{runnerResourceSummary(runner)}</small>
                    </div>
                    <div role="cell">
                      <span>最近心跳</span>
                      <strong>
                        <time dateTime={runner.lastSeenAt} title={`UTC：${runner.lastSeenAt}`}>
                          {formatDate(runner.lastSeenAt, timeZone)}
                        </time>
                      </strong>
                      <small>{recentBatchLabel(recentBatches, runner.id)}</small>
                    </div>
                  </div>

                  <footer
                    className={cn("runner-list-actions", pageStyles["runner-list-actions"])}
                    role="cell"
                  >
                    {runner.credentialRevokedAt && !runner.deregisteredAt ? (
                      <Badge className={cn("tag", uiPatterns["tag"])}>凭据已撤销</Badge>
                    ) : null}
                    {updateAvailable ? (
                      <Badge className={cn("tag", uiPatterns["tag"])}>
                        可更新至 {bundledAgentVersion}
                      </Badge>
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
        {pageCount > 1 ? (
          <nav aria-label="执行机分页" className={cn("pagination", pageStyles["pagination"])}>
            {currentPage > 1 ? (
              <Link href={runnerPageHref(parameters, currentPage - 1)}>上一页</Link>
            ) : (
              <span />
            )}
            <span>
              第 {currentPage} / {pageCount} 页
            </span>
            {currentPage < pageCount ? (
              <Link href={runnerPageHref(parameters, currentPage + 1)}>下一页</Link>
            ) : null}
          </nav>
        ) : null}
      </Card>
    </div>
  );
}

function singleParameter(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim().slice(0, 120) ?? "";
}

function runnerStateParameter(value: string | string[] | undefined): Runner["state"] | undefined {
  const state = singleParameter(value);
  return ["online", "offline", "draining", "disabled"].includes(state)
    ? (state as Runner["state"])
    : undefined;
}

function positiveInteger(value: string | string[] | undefined): number {
  const parsed = Number(singleParameter(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function runnerPageHref(
  parameters: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const next = new URLSearchParams();
  const query = singleParameter(parameters.query);
  const state = runnerStateParameter(parameters.state);
  if (query) next.set("query", query);
  if (state) next.set("state", state);
  next.set("page", String(page));
  return `/runners?${next}`;
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
  return `${runner.state === "offline" ? "最近心跳数据：" : ""}CPU ${runner.resourceSnapshot.cpuUtilizationPercent}% · 内存 ${runner.resourceSnapshot.memoryUtilizationPercent}% · 负载/CPU ${loadPerCpu.toFixed(2)}`;
}

function recentBatchLabel(
  batches: Pick<RunBatch, "selectedRunnerIds" | "suiteName" | "status">[],
  runnerId: string,
): string {
  const batch = batches.find((candidate) => candidate.selectedRunnerIds.includes(runnerId));
  return batch ? `${batch.suiteName} · ${runBatchStatusLabel(batch.status)}` : "暂无可见任务";
}

const pageStyles = {
  "has-runners":
    "[&_.runner-installer-launcher]:py-3 [&_.runner-installer-launcher]:px-4 [&_.runner-installer-heading_:is(.eyebrow,_p,_.settings-icon)]:hidden [&_.runner-installer-heading_h2]:m-0 [&_.runner-installer-heading_h2]:text-sm",
  "live-dot": "w-2 h-2 rounded-full bg-success shadow-xs",
  pagination: "flex justify-end py-3.5 px-4.5 border-t border-solid border-border",
  "runner-list": "grid gap-[7px] py-2.5 px-3",
  "runner-list-actions":
    "flex min-w-0 items-center flex-wrap justify-end gap-2 border-l border-solid border-border pl-3 max-[1281px]:col-span-full max-[1281px]:border-l-0 max-[1281px]:pl-0",
  "runner-list-card": "overflow-visible",
  "runner-list-facts":
    "[&_small]:text-muted-foreground [&_small]:text-xs [&_small]:min-w-0 [&_small]:[overflow-wrap:anywhere] grid min-w-0 grid-cols-3 gap-px overflow-hidden border border-solid border-border rounded-lg bg-border [&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:content-start [&_>_div]:gap-1 [&_>_div]:p-2 [&_>_div]:bg-muted [&_>_div_>_span]:text-muted-foreground [&_>_div_>_span]:text-xs [&_strong]:min-w-0 [&_strong]:[overflow-wrap:anywhere] max-[1281px]:col-span-full",
  "runner-list-filter":
    "grid grid-cols-[minmax(220px,_1fr)_minmax(160px,_220px)_auto] items-end gap-3 p-3 border-b border-solid border-border [&_>_label]:grid [&_>_label]:gap-1.5 [&_>_label]:text-muted-foreground [&_>_label]:text-xs [&_>_label]:font-semibold",
  "runner-list-header":
    "flex min-w-0 items-center justify-between gap-3 max-[1281px]:col-span-full",
  "runner-list-identity":
    "flex min-w-0 items-center gap-2 [&_>_span]:grid [&_>_span]:min-w-0 [&_>_span]:gap-0.5 [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal [&_small]:[overflow-wrap:anywhere] [&_small]:whitespace-normal [&_small]:text-muted-foreground [&_small]:text-xs",
  "runner-list-item":
    "grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-3 border border-solid border-border rounded-lg p-3 bg-card shadow-xs max-[1281px]:grid-cols-1",
  "runner-metrics":
    "grid grid-cols-[repeat(3,_1fr)] gap-3.5 [&_.card]:grid [&_.card]:grid-cols-[38px_minmax(0,_1fr)_auto] [&_.card]:items-center [&_.card]:gap-2.5 [&_.card]:p-4 [&_.card]:text-muted-foreground [&_.card_svg]:p-2 [&_.card_svg]:rounded-lg [&_.card_svg]:bg-info/10 [&_.card_svg]:text-info [&_.card_svg]:[box-sizing:content-box] [&_strong]:text-foreground [&_strong]:text-2xl",
  "runner-state":
    "inline-flex [flex:0_0_auto] items-center gap-1.5 text-xs font-semibold whitespace-nowrap [&_i]:w-[7px] [&_i]:h-[7px] [&_i]:rounded-full [&_i]:bg-muted-foreground [&.runner-state-online]:text-success [&.runner-state-online]:[&_i]:bg-success [&.runner-state-disabled]:text-destructive [&.runner-state-disabled]:[&_i]:bg-destructive",
  "storage-pill":
    "inline-flex items-center gap-2 border border-solid border-border rounded-full py-[9px] px-[13px] bg-card text-muted-foreground text-xs font-semibold shadow-xs",
  "table-count": "text-muted-foreground text-xs whitespace-nowrap",
} as const;
