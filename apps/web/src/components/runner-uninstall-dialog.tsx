"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RunnerHostProbeResult, RunnerInstallationProfile } from "@autoforge/contracts";
import {
  runnerHostProbeResultSchema,
  runnerAgentUninstallResultSchema,
} from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { Button, Input, Select } from "./ui";
import { Notice } from "./ui/notice";
import { useToast } from "./ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";

export function RunnerUninstallDialog({
  runnerId,
  runnerName,
  profile,
}: {
  runnerId: string;
  runnerName: string;
  profile?: RunnerInstallationProfile;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [useStored, setUseStored] = useState(Boolean(profile));
  const [host, setHost] = useState(profile?.host ?? "");
  const [port, setPort] = useState(profile?.port ?? 22);
  const [username, setUsername] = useState(profile?.username ?? "");
  const [password, setPassword] = useState("");
  const [installationMode, setInstallationMode] = useState(profile?.installationMode ?? "auto");
  const [probe, setProbe] = useState<RunnerHostProbeResult>();
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState<"probe" | "uninstall">();
  const [error, setError] = useState("");
  function resetVerification(change: () => void) {
    change();
    setProbe(undefined);
    setFingerprintConfirmed(false);
    setError("");
  }
  function close() {
    if (pending) return;
    setOpen(false);
    setPassword("");
    setProbe(undefined);
    setFingerprintConfirmed(false);
    setConsent(false);
    setError("");
  }
  async function request(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(await readApiErrorMessage(response, "操作失败，请核对 SSH 连接后重试。"));
    return response.json() as Promise<unknown>;
  }
  async function probeHost() {
    if (pending) return;
    setPending("probe");
    setError("");
    try {
      setProbe(
        runnerHostProbeResultSchema.parse(
          await request("/api/v1/runners/installations/probe", {
            connection: { host, port, username, password },
            installationMode,
          }),
        ),
      );
      setFingerprintConfirmed(false);
    } catch (cause) {
      setProbe(undefined);
      setError(cause instanceof Error ? cause.message : "探测失败。");
    } finally {
      setPending(undefined);
    }
  }
  async function uninstall() {
    if (pending || !consent || (!useStored && (!probe || !fingerprintConfirmed))) return;
    setPending("uninstall");
    setError("");
    try {
      const result = runnerAgentUninstallResultSchema.parse(
        await request(
          `/api/v1/runners/${encodeURIComponent(runnerId)}/uninstall`,
          useStored && profile
            ? { profileId: profile.id, confirm: true }
            : {
                connection: { host, port, username, password },
                installationMode,
                expectedHostKeySha256: probe!.hostKeySha256,
                confirm: true,
              },
        ),
      );
      toast.success(
        result.dataDirectoryRetained
          ? "Agent 已卸载，平台节点已移除。含其他文件或作为挂载点的数据目录已保留。"
          : "Agent、本地执行数据和已保存连接已清理，平台节点已移除。",
      );
      setOpen(false);
      setPassword("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "卸载失败，请重试。");
    } finally {
      setPending(undefined);
    }
  }
  return (
    <>
      <Button type="button" variant="danger" onClick={() => setOpen(true)}>
        卸载 Agent
      </Button>
      <ActionDialog
        open={open}
        title="卸载执行机 Agent"
        description={runnerName}
        onClose={close}
        className="w-[min(680px,_calc(100dvw_-_40px))]"
      >
        <div className="grid min-w-0 gap-4">
          <Notice tone="warning">
            <strong>永久清理执行机上的 Agent 和本地执行数据</strong>
            <p className="mb-0 mt-2">
              停止服务，删除程序、Adapter、配置、凭据、缓存、工作目录和本地产物，并移除平台节点及已保存
              SSH
              连接。当前执行会被中断并按现有恢复策略处理，请优先排空节点。平台已保存的历史执行和日志保留。
            </p>
          </Notice>
          {error ? (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          ) : null}
          {profile ? (
            <label className="flex items-center gap-2">
              <Input
                type="checkbox"
                checked={useStored}
                disabled={Boolean(pending)}
                onChange={(event) => resetVerification(() => setUseStored(event.target.checked))}
              />
              使用已保存的 SSH 连接
            </label>
          ) : null}
          {useStored && profile ? (
            <div className="grid min-w-0 gap-2 rounded-md border border-border bg-muted p-3 text-sm">
              <strong className="break-all">
                {profile.username}@{profile.host}:{profile.port}
              </strong>
              <span className="break-all text-muted-foreground">
                数据目录：{profile.dataDirectory ?? "读取远端实际配置"}
              </span>
              <span className="break-all font-mono text-xs">{profile.expectedHostKeySha256}</span>
            </div>
          ) : (
            <div className="grid min-w-0 gap-3">
              <div className="grid grid-cols-[minmax(0,_1fr)_120px] gap-3">
                <label className="grid min-w-0 gap-2">
                  执行机 IP / 主机名
                  <Input
                    value={host}
                    disabled={Boolean(pending)}
                    onChange={(event) => resetVerification(() => setHost(event.target.value))}
                  />
                </label>
                <label className="grid min-w-0 gap-2">
                  SSH 端口
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    disabled={Boolean(pending)}
                    onChange={(event) =>
                      resetVerification(() => setPort(Number(event.target.value)))
                    }
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid min-w-0 gap-2">
                  用户名
                  <Input
                    value={username}
                    disabled={Boolean(pending)}
                    onChange={(event) => resetVerification(() => setUsername(event.target.value))}
                  />
                </label>
                <label className="grid min-w-0 gap-2">
                  SSH / sudo 密码
                  <Input
                    type="password"
                    value={password}
                    autoComplete="off"
                    disabled={Boolean(pending)}
                    onChange={(event) => resetVerification(() => setPassword(event.target.value))}
                  />
                </label>
              </div>
              <label className="grid gap-2">
                安装系统模式
                <Select
                  value={installationMode}
                  disabled={Boolean(pending)}
                  onChange={(event) =>
                    resetVerification(() =>
                      setInstallationMode(event.target.value as typeof installationMode),
                    )
                  }
                >
                  <option value="auto">自动识别</option>
                  <option value="ubuntu">Ubuntu</option>
                  <option value="opensuse">openSUSE / 兼容 SUSE</option>
                  <option value="opensuse-leap">openSUSE Leap</option>
                  <option value="opensuse-tumbleweed">openSUSE Tumbleweed</option>
                </Select>
              </label>
              <div>
                <Button
                  type="button"
                  disabled={Boolean(pending) || !host || !username || !password}
                  onClick={() => void probeHost()}
                >
                  {pending === "probe" ? "正在探测…" : "探测并核验主机"}
                </Button>
              </div>
              {probe ? (
                <div className="grid min-w-0 gap-2 rounded-md border border-border p-3 text-sm">
                  <span>
                    {probe.operatingSystemName} · {probe.architecture}
                  </span>
                  <code className="break-all text-xs">{probe.hostKeySha256}</code>
                  <label className="flex items-start gap-2">
                    <Input
                      type="checkbox"
                      checked={fingerprintConfirmed}
                      disabled={Boolean(pending)}
                      onChange={(event) => setFingerprintConfirmed(event.target.checked)}
                    />
                    我已通过可信渠道核对并确认上述 SSH 主机指纹
                  </label>
                </div>
              ) : null}
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Input
              type="checkbox"
              checked={consent}
              disabled={Boolean(pending)}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我确认卸载并永久删除该执行机的 Agent 本地数据
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" disabled={Boolean(pending)} onClick={close}>
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={
                Boolean(pending) || !consent || (!useStored && (!probe || !fingerprintConfirmed))
              }
              onClick={() => void uninstall()}
            >
              {pending === "uninstall" ? "正在卸载并清理…" : "确认卸载并清理"}
            </Button>
          </div>
        </div>
      </ActionDialog>
    </>
  );
}
