import { Clock3, Server, ShieldCheck } from "lucide-react";

import { RunnerTerminal } from "@/components/runner-terminal";
import { getPlatformServices } from "@/lib/services";

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
  const services = await getPlatformServices();
  const runners = await services.runnerControl.list(500);
  const onlineCount = runners.filter((runner) => runner.state === "online").length;
  return (
    <div className="page-stack">
      <section className="page-hero">
        <div>
          <span className="eyebrow">Runner Control</span>
          <h1>执行机</h1>
          <p>Agent 主动注册并持续上报心跳；45 秒未上报会显示离线。</p>
        </div>
        <span className="storage-pill">
          <span className="live-dot" /> 在线 {onlineCount} / {runners.length}
        </span>
      </section>
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
            <p>设置 Runner bootstrap token，启动 `autoforge-agent start` 后会自动出现。</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>执行机</th>
                  <th>平台</th>
                  <th>容量</th>
                  <th>资源</th>
                  <th>状态</th>
                  <th>最近心跳</th>
                  <th>终端</th>
                </tr>
              </thead>
              <tbody>
                {runners.map((runner) => {
                  return (
                    <tr key={runner.id}>
                      <td>
                        <span className="class-cell">
                          <strong>{runner.name}</strong>
                          <small>{runner.labels.join(" · ") || "无标签"}</small>
                        </span>
                      </td>
                      <td>
                        {runner.os} · {runner.architecture}
                        <br />
                        <small className="muted">Agent {runner.agentVersion}</small>
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
                          {runner.state === "online"
                            ? "在线"
                            : runner.state === "disabled"
                              ? "已禁用"
                              : "离线"}
                        </span>
                      </td>
                      <td>
                        <time dateTime={runner.lastSeenAt}>{formatDate(runner.lastSeenAt)}</time>
                      </td>
                      <td>
                        <RunnerTerminal
                          runnerId={runner.id}
                          runnerName={runner.name}
                          platformEnabled={Boolean(services.config.terminalAccessToken)}
                          runnerEnabled={runner.terminalEnabled}
                          runnerOnline={runner.state === "online"}
                        />
                      </td>
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
