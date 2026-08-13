"use client";

import { Button, Input, Textarea } from "@/components/ui";

import {
  runnerAgentInstallationResultSchema,
  runnerAgentRollbackResultSchema,
  runnerHostProbeResultSchema,
  type RunnerAgentInstallationResult,
  type RunnerAgentRollbackResult,
  type RunnerHostProbeResult,
} from "@autoforge/contracts";
import { CheckCircle2, Fingerprint, HardDriveDownload, Search, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type RunnerAgentInstallerProps = {
  controlPlaneUrl: string | undefined;
};

export function RunnerAgentInstaller({ controlPlaneUrl }: RunnerAgentInstallerProps) {
  const router = useRouter();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("linux");
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [terminalEnabled, setTerminalEnabled] = useState(false);
  const [caCertificatePem, setCaCertificatePem] = useState("");
  const [probe, setProbe] = useState<RunnerHostProbeResult>();
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [result, setResult] = useState<RunnerAgentInstallationResult>();
  const [rollbackResult, setRollbackResult] = useState<RunnerAgentRollbackResult>();
  const [pending, setPending] = useState<"probe" | "install" | "rollback">();
  const [error, setError] = useState("");

  function connectionChanged(change: () => void) {
    change();
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
        connection: { host, port, username, password },
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
      const response = await postJson("/api/v1/runners/installations", {
        connection: { host, port, username, password },
        expectedHostKeySha256: probe.hostKeySha256,
        name,
        labels: labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
        maxConcurrency,
        terminalEnabled,
        ...(caCertificatePem.trim() ? { caCertificatePem } : {}),
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
    if (!window.confirm("回滚到该执行机上一次成功安装的 Agent？服务会短暂重启。")) return;
    setPending("rollback");
    setError("");
    setRollbackResult(undefined);
    try {
      const response = await postJson("/api/v1/runners/installations/rollback", {
        connection: { host, port, username, password },
        expectedHostKeySha256: probe.hostKeySha256,
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
            密码仅在本次操作的内存中使用，不会保存。
          </p>
        </div>
      </div>

      {!controlPlaneUrl ? (
        <div className="inline-notice warning-notice" role="status">
          <ShieldAlert size={18} />
          <span>请先在“平台配置”中设置执行机可访问的 HTTPS 地址，保存并重启主平台。</span>
        </div>
      ) : (
        <div className="runner-control-url">
          <span>Agent 控制面</span>
          <code>{controlPlaneUrl}</code>
        </div>
      )}

      <div className="runner-installer-grid">
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
          disabled={!host || !username || !password || Boolean(pending)}
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
                {probe.architecture} · systemd · {probe.privilegeMode}
              </small>
            </span>
          </div>
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
            <label className="checkbox-field">
              <Input
                checked={terminalEnabled}
                onChange={(event) => setTerminalEnabled(event.target.checked)}
                type="checkbox"
              />
              允许管理员直连终端
            </label>
          </div>
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
              {pending === "install" ? "正在安装并启动…" : "安装内置 Agent"}
            </Button>
            <Button
              className="button-danger-quiet"
              disabled={!fingerprintConfirmed || Boolean(pending)}
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
