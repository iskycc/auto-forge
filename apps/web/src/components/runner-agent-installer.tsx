"use client";

import { Button, Input, Select, Textarea } from "@/components/ui";
import { useConfirm } from "@/components/ui-feedback";

import {
  DEFAULT_RUNNER_DATA_DIRECTORY,
  runnerAgentInstallationResultSchema,
  runnerAgentRollbackResultSchema,
  runnerHostProbeResultSchema,
  type RunnerAgentInstallationResult,
  type RunnerAgentRollbackResult,
  type RunnerHostProbeResult,
  type RunnerInstallationProfile,
} from "@autoforge/contracts";
import { CheckCircle2, Fingerprint, HardDriveDownload, Search, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type RunnerAgentInstallerProps = {
  controlPlaneUrl: string | undefined;
  profiles: readonly RunnerInstallationProfile[];
  linkedRunners: readonly {
    id: string;
    labels: readonly string[];
    maxConcurrency: number;
    name: string;
    terminalEnabled: boolean;
  }[];
};

export function RunnerAgentInstaller({
  controlPlaneUrl,
  profiles,
  linkedRunners,
}: RunnerAgentInstallerProps) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("linux");
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [terminalEnabled, setTerminalEnabled] = useState(false);
  const [runAsRoot, setRunAsRoot] = useState(false);
  const [dataDirectory, setDataDirectory] = useState("");
  const [installationMode, setInstallationMode] = useState<
    "auto" | "ubuntu" | "opensuse" | "opensuse-leap" | "opensuse-tumbleweed"
  >("auto");
  const [caCertificatePem, setCaCertificatePem] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [probe, setProbe] = useState<RunnerHostProbeResult>();
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [result, setResult] = useState<RunnerAgentInstallationResult>();
  const [rollbackResult, setRollbackResult] = useState<RunnerAgentRollbackResult>();
  const [pending, setPending] = useState<"probe" | "install" | "rollback">();
  const [error, setError] = useState("");

  function connectionChanged(change: () => void, clearStoredProfile = true) {
    change();
    if (clearStoredProfile) setSelectedProfileId("");
    setProbe(undefined);
    setFingerprintConfirmed(false);
    setResult(undefined);
    setRollbackResult(undefined);
    setError("");
  }

  async function probeHost() {
    setPending("probe");
    setError("");
    setResult(undefined);
    setRollbackResult(undefined);
    try {
      const response = await postJson("/api/v1/runners/installations/probe", {
        ...(selectedProfileId && !password
          ? { profileId: selectedProfileId }
          : { connection: { host, port, username, password } }),
        installationMode,
      });
      const inspected = runnerHostProbeResultSchema.parse(response);
      setProbe(inspected);
      setFingerprintConfirmed(false);
      if (!name.trim()) setName(`runner-${host.replace(/[^a-zA-Z0-9._-]+/g, "-")}`.slice(0, 128));
    } catch (cause) {
      setProbe(undefined);
      setError(errorMessage(cause));
    } finally {
      setPending(undefined);
    }
  }

  async function installAgent() {
    if (!probe || !fingerprintConfirmed) return;
    setPending("install");
    setError("");
    setRollbackResult(undefined);
    try {
      const configuration = {
        expectedHostKeySha256: probe.hostKeySha256,
        name,
        labels: labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
        maxConcurrency,
        terminalEnabled,
        runAsRoot,
        installationMode,
        dataDirectory: dataDirectory.trim() || DEFAULT_RUNNER_DATA_DIRECTORY,
        ...(caCertificatePem.trim() ? { caCertificatePem } : {}),
      };
      const response = await postJson("/api/v1/runners/installations", {
        ...(selectedProfileId && !password
          ? { profileId: selectedProfileId }
          : { connection: { host, port, username, password } }),
        ...configuration,
      });
      const installed = runnerAgentInstallationResultSchema.parse(response);
      setResult(installed);
      setPassword("");
      setFingerprintConfirmed(false);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(undefined);
    }
  }

  async function rollbackAgent() {
    if (!probe || !fingerprintConfirmed) return;
    if (
      !(await confirmAction({
        title: "回滚 Runner Agent",
        description: "将恢复该执行机上一次成功安装的 Agent，服务会短暂重启。",
        confirmLabel: "确认回滚",
        tone: "danger",
      }))
    )
      return;
    setPending("rollback");
    setError("");
    setRollbackResult(undefined);
    try {
      const response = await postJson("/api/v1/runners/installations/rollback", {
        connection: { host, port, username, password },
        expectedHostKeySha256: probe.hostKeySha256,
        installationMode,
      });
      setRollbackResult(runnerAgentRollbackResultSchema.parse(response));
      setPassword("");
      setFingerprintConfirmed(false);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <section className="card runner-installer-card">
      <div className="runner-installer-heading">
        <span className="settings-icon">
          <HardDriveDownload size={20} />
        </span>
        <div>
          <span className="eyebrow">Internal Agent Resource</span>
          <h2>自动安装执行机 Agent</h2>
          <p>
            平台通过 SSH 探测目标主机，核验指纹后上传内置静态 Agent，并配置为 systemd 服务。SSH
            连接信息会使用平台主密钥 AES-GCM 加密保存，后续安装或批量更新无需重复输入密码。
          </p>
        </div>
      </div>

      {!controlPlaneUrl ? (
        <div className="inline-notice warning-notice" role="status">
          <ShieldAlert size={18} />
          <span>请先在“平台配置”中设置内部访问地址或外部访问地址。</span>
        </div>
      ) : (
        <div className="runner-control-url">
          <span>Agent 控制面</span>
          <code>{controlPlaneUrl}</code>
        </div>
      )}
      {controlPlaneUrl?.startsWith("http:") ? (
        <div className="inline-notice warning-notice" role="status">
          <ShieldAlert size={18} />
          <span>当前使用明文 HTTP，Runner 凭据和任务数据不会被传输层加密，请仅用于可信内网。</span>
        </div>
      ) : null}
      {controlPlaneUrl && isLoopbackUrl(controlPlaneUrl) ? (
        <div className="inline-notice warning-notice" role="status">
          <ShieldAlert size={18} />
          <span>
            当前控制面地址仅本机可达。安装到其他主机前，请在“平台配置”中设置 Runner
            可访问的内部地址。
          </span>
        </div>
      ) : null}

      {profiles.length > 0 ? (
        <div className="runner-saved-profile-row">
          <label>
            已保存连接
            <Select
              disabled={Boolean(pending)}
              onChange={(event) => {
                const profileId = event.target.value;
                setSelectedProfileId(profileId);
                const profile = profiles.find((candidate) => candidate.id === profileId);
                if (!profile) return;
                setHost(profile.host);
                setPort(profile.port);
                setUsername(profile.username);
                setName(profile.runnerName);
                setInstallationMode(profile.installationMode);
                setRunAsRoot(profile.runAsRoot);
                setDataDirectory(profile.dataDirectory ?? "");
                setCaCertificatePem("");
                setLabels("linux");
                setMaxConcurrency(1);
                setTerminalEnabled(false);
                const linkedRunner = profile.runnerId
                  ? linkedRunners.find((runner) => runner.id === profile.runnerId)
                  : undefined;
                if (linkedRunner) {
                  setName(linkedRunner.name);
                  setLabels(linkedRunner.labels.join(","));
                  setMaxConcurrency(linkedRunner.maxConcurrency);
                  setTerminalEnabled(linkedRunner.terminalEnabled);
                }
                setPassword("");
                setProbe(undefined);
                setFingerprintConfirmed(false);
                setResult(undefined);
                setRollbackResult(undefined);
                setError("");
              }}
              value={selectedProfileId}
            >
              <option value="">选择已保存的执行机连接</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.runnerName} · {profile.username}@{profile.host}:{profile.port}
                  {profile.runnerId ? ` · Runner ${profile.runnerId.slice(0, 8)}` : " · 待绑定"}
                </option>
              ))}
            </Select>
          </label>
          <Button
            className="button button-primary"
            disabled={!selectedProfileId || !name.trim() || Boolean(pending)}
            onClick={() => void probeHost()}
            type="button"
          >
            <Search size={16} />
            {pending === "probe" ? "正在探测…" : "载入连接并探测"}
          </Button>
        </div>
      ) : null}

      <div className="runner-installer-grid">
        <label>
          安装系统模式
          <Select
            disabled={Boolean(pending)}
            onChange={(event) =>
              connectionChanged(
                () => setInstallationMode(event.target.value as typeof installationMode),
                false,
              )
            }
            value={installationMode}
          >
            <option value="auto">自动识别（推荐）</option>
            <option value="ubuntu">强制 Ubuntu</option>
            <option value="opensuse">强制 openSUSE</option>
            <option value="opensuse-leap">强制 openSUSE Leap</option>
            <option value="opensuse-tumbleweed">强制 openSUSE Tumbleweed</option>
          </Select>
          <small>系统标识错误时可手动选择；仍会校验 Bash、systemd、架构和权限。</small>
        </label>
        <label>
          执行机 IP / 主机名
          <Input
            autoComplete="off"
            disabled={Boolean(pending)}
            onChange={(event) => connectionChanged(() => setHost(event.target.value))}
            placeholder="10.20.30.40"
            value={host}
          />
        </label>
        <label>
          SSH 端口
          <Input
            disabled={Boolean(pending)}
            max={65_535}
            min={1}
            onChange={(event) => connectionChanged(() => setPort(Number(event.target.value)))}
            type="number"
            value={port}
          />
        </label>
        <label>
          用户名
          <Input
            autoComplete="username"
            disabled={Boolean(pending)}
            onChange={(event) => connectionChanged(() => setUsername(event.target.value))}
            placeholder="root 或可 sudo 的用户"
            value={username}
          />
        </label>
        <label>
          SSH / sudo 密码
          <Input
            autoComplete="current-password"
            disabled={Boolean(pending)}
            onChange={(event) => connectionChanged(() => setPassword(event.target.value))}
            type="password"
            value={password}
          />
        </label>
      </div>

      <div className="runner-installer-actions">
        <Button
          className="button-secondary"
          disabled={!host || !username || (!password && !selectedProfileId) || Boolean(pending)}
          onClick={() => void probeHost()}
          type="button"
        >
          <Search size={16} /> {pending === "probe" ? "正在探测…" : "探测并核验主机"}
        </Button>
        <small>支持 Ubuntu、openSUSE Leap/Tumbleweed，以及 amd64、arm64。</small>
      </div>

      {probe ? (
        <div className="runner-probe-result">
          <div className="runner-probe-summary">
            <CheckCircle2 size={20} />
            <span>
              <strong>{probe.operatingSystemName}</strong>
              <small>
                {probe.architecture} · systemd · {probe.privilegeMode} · {probe.bashPath}
                {probe.cgroupV2Available ? " · cgroup v2" : " · 无 cgroup v2（降级隔离）"}
              </small>
            </span>
          </div>
          {probe.forcedInstallationMode ||
          probe.detectedOperatingSystemId !== probe.operatingSystemId ? (
            <div className="inline-notice warning-notice" role="status">
              <ShieldAlert size={18} />
              <span>
                系统报告为 {probe.detectedOperatingSystemId}，将按 {probe.operatingSystemId}
                模式安装。请确认目标机确实兼容该模式。
              </span>
            </div>
          ) : null}
          <div className="runner-fingerprint">
            <Fingerprint size={18} />
            <span>
              <small>SSH 主机指纹</small>
              <code>{probe.hostKeySha256}</code>
            </span>
          </div>
          <label className="checkbox-row runner-fingerprint-confirmation">
            <Input
              checked={fingerprintConfirmed}
              onChange={(event) => setFingerprintConfirmed(event.target.checked)}
              type="checkbox"
            />
            我已通过可信渠道核对并确认上述 SSH 主机指纹
          </label>

          <div className="runner-installer-grid runner-install-options">
            <label>
              执行机名称
              <Input onChange={(event) => setName(event.target.value)} value={name} />
            </label>
            <label>
              标签（逗号分隔）
              <Input onChange={(event) => setLabels(event.target.value)} value={labels} />
            </label>
            <label>
              最大并发
              <Input
                max={64}
                min={1}
                onChange={(event) => setMaxConcurrency(Number(event.target.value))}
                type="number"
                value={maxConcurrency}
              />
            </label>
            <label>
              工作目录
              <Input
                autoComplete="off"
                onChange={(event) => setDataDirectory(event.target.value)}
                placeholder={DEFAULT_RUNNER_DATA_DIRECTORY}
                value={dataDirectory}
              />
              <small>留空使用默认 {DEFAULT_RUNNER_DATA_DIRECTORY}；需为绝对路径。</small>
            </label>
            <label className="checkbox-field">
              <Input
                checked={terminalEnabled}
                onChange={(event) => setTerminalEnabled(event.target.checked)}
                type="checkbox"
              />
              允许管理员直连终端
            </label>
            <label className="checkbox-field">
              <Input
                checked={runAsRoot}
                onChange={(event) => setRunAsRoot(event.target.checked)}
                type="checkbox"
              />
              以 root 身份运行 Agent
            </label>
          </div>
          {runAsRoot ? (
            <div className="inline-notice warning-notice" role="status">
              <ShieldAlert size={18} />
              <span>root 模式会扩大测试进程可访问的主机资源范围，仅建议用于受控内网执行机。</span>
            </div>
          ) : null}
          {!probe.cgroupV2Available ? (
            <div className="inline-notice warning-notice" role="status">
              <ShieldAlert size={18} />
              <span>
                无 cgroup v2 时不能硬性限制整个进程树的 CPU、内存和进程数，请只运行可信用例。
              </span>
            </div>
          ) : null}
          <label>
            私有 CA 证书（可选，PEM）
            <Textarea
              onChange={(event) => setCaCertificatePem(event.target.value)}
              placeholder="控制面使用私有 CA 时粘贴；公有可信证书请留空。"
              rows={4}
              value={caCertificatePem}
            />
          </label>
          <div className="runner-installer-actions">
            <Button
              className="button-primary"
              disabled={!fingerprintConfirmed || !name.trim() || Boolean(pending)}
              onClick={() => void installAgent()}
              type="button"
            >
              <HardDriveDownload size={16} />
              {pending === "install"
                ? "正在安装并启动…"
                : selectedProfileId
                  ? "按上述配置重新安装 Agent"
                  : "安装内置 Agent"}
            </Button>
            <Button
              className="button-danger-quiet"
              disabled={!fingerprintConfirmed || !password || Boolean(pending)}
              onClick={() => void rollbackAgent()}
              type="button"
            >
              {pending === "rollback" ? "正在回滚…" : "回滚上次安装"}
            </Button>
            <small>安装过程不会调用系统包管理器，也不会下载任何外部依赖。</small>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="form-success" role="status">
          <CheckCircle2 size={18} />
          Agent {result.agentVersion} 已安装到 {result.host}
          ；服务已启动，执行机将在注册后出现在下方列表。
        </div>
      ) : null}
      {rollbackResult ? (
        <div className="form-success" role="status">
          <CheckCircle2 size={18} />
          Agent 已回滚到 {rollbackResult.agentVersion}；systemd 健康检查通过。
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? "执行机操作失败。");
  return payload;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "执行机操作失败。";
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}
