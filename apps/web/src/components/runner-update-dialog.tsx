"use client";

import {
  runnerAgentInstallationResultSchema,
  runnerHostProbeResultSchema,
  type RunnerAgentInstallationResult,
  type RunnerHostProbeResult,
} from "@autoforge/contracts";
import { CheckCircle2, Download, Fingerprint, Search, ShieldAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Input, Select } from "@/components/ui";

type RunnerUpdateDialogProps = {
  runnerId: string;
  runnerName: string;
  latestVersion: string;
};

export function RunnerUpdateDialog({
  runnerId,
  runnerName,
  latestVersion,
}: RunnerUpdateDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [runAsRoot, setRunAsRoot] = useState(false);
  const [installationMode, setInstallationMode] = useState<
    "auto" | "ubuntu" | "opensuse" | "opensuse-leap" | "opensuse-tumbleweed"
  >("auto");
  const [probe, setProbe] = useState<RunnerHostProbeResult>();
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [result, setResult] = useState<RunnerAgentInstallationResult>();
  const [pending, setPending] = useState<"probe" | "update">();
  const [error, setError] = useState("");

  function connectionChanged(change: () => void) {
    change();
    setProbe(undefined);
    setFingerprintConfirmed(false);
    setResult(undefined);
    setError("");
  }

  function closeDialog() {
    if (pending) return;
    setOpen(false);
    setProbe(undefined);
    setFingerprintConfirmed(false);
    setResult(undefined);
    setError("");
  }

  async function probeHost() {
    setPending("probe");
    setError("");
    setResult(undefined);
    try {
      const response = await postJson("/api/v1/runners/installations/probe", {
        connection: { host, port, username, password },
        installationMode,
      });
      setProbe(runnerHostProbeResultSchema.parse(response));
      setFingerprintConfirmed(false);
    } catch (cause) {
      setProbe(undefined);
      setError(errorMessage(cause));
    } finally {
      setPending(undefined);
    }
  }

  async function updateAgent() {
    if (!probe || !fingerprintConfirmed) return;
    setPending("update");
    setError("");
    try {
      const response = await postJson(`/api/v1/runners/${runnerId}/update`, {
        connection: { host, port, username, password },
        expectedHostKeySha256: probe.hostKeySha256,
        runAsRoot,
        installationMode,
      });
      setResult(runnerAgentInstallationResultSchema.parse(response));
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
    <>
      <Button
        className="button button-secondary"
        onClick={() => setOpen(true)}
        title={`更新到内置 Agent ${latestVersion}`}
        type="button"
      >
        <Download size={15} /> 更新
      </Button>
      {open ? (
        <div className="runner-update-overlay" role="presentation" onMouseDown={closeDialog}>
          <section
            aria-label={`更新 ${runnerName} 的 Agent`}
            aria-modal="true"
            className="runner-update-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="runner-update-titlebar">
              <span>
                <Download size={16} aria-hidden="true" />
                <strong>更新执行机 Agent</strong>
                <small>
                  {runnerName} → {latestVersion}
                </small>
              </span>
              <Button aria-label="关闭" onClick={closeDialog} type="button">
                <X size={16} />
              </Button>
            </header>
            <div className="runner-update-body">
              <p className="runner-update-hint">
                原地更新会保留执行机身份、凭据与历史执行记录，仅替换 Agent
                并重启服务；名称、标签与并发以平台记录为准。更新前自动备份，失败可在自动安装面板回滚。SSH
                密码仅在本次操作的内存中使用，不会保存。
              </p>
              <div className="runner-update-grid">
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
                    onChange={(event) =>
                      connectionChanged(() => setPort(Number(event.target.value)))
                    }
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
                <label>
                  安装系统模式
                  <Select
                    disabled={Boolean(pending)}
                    onChange={(event) =>
                      connectionChanged(() =>
                        setInstallationMode(event.target.value as typeof installationMode),
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
                </label>
                <label className="checkbox-row">
                  <Input
                    checked={runAsRoot}
                    disabled={Boolean(pending)}
                    onChange={(event) => setRunAsRoot(event.target.checked)}
                    type="checkbox"
                  />
                  以 root 身份运行 Agent
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
                  <div className="runner-installer-actions">
                    <Button
                      className="button-primary"
                      disabled={!fingerprintConfirmed || Boolean(pending)}
                      onClick={() => void updateAgent()}
                      type="button"
                    >
                      <Download size={16} />
                      {pending === "update" ? "正在更新并重启…" : `更新到 ${latestVersion}`}
                    </Button>
                    <small>更新前会自动备份当前版本，失败可回滚。</small>
                  </div>
                </div>
              ) : null}

              {result ? (
                <div className="form-success" role="status">
                  <CheckCircle2 size={18} />
                  Agent {result.agentVersion} 已更新到 {result.host}
                  ；服务已重启，执行机身份与历史记录保持不变。
                </div>
              ) : null}
              {error ? (
                <div className="runner-update-error">
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                  <div className="inline-notice warning-notice" role="status">
                    <ShieldAlert size={18} />
                    <span>
                      更新失败时旧版本会自动保留；也可在页面顶部“自动安装执行机
                      Agent”面板中使用同一主机凭据执行“回滚上次安装”。
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? "执行机更新失败。");
  return payload;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "执行机更新失败。";
}
