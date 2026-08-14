import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  InstallRunnerAgentInput,
  RollbackRunnerAgentInput,
  RunnerAgentInstallationResult,
  RunnerAgentRollbackResult,
  RunnerHostProbeResult,
} from "@autoforge/contracts";
import { DomainError } from "@autoforge/domain";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";

import {
  RunnerAgentResourceStore,
  type AgentArchitecture,
  type RunnerAgentResources,
} from "./runner-agent-resources";

const SSH_READY_TIMEOUT_MS = 15_000;
const REMOTE_COMMAND_TIMEOUT_MS = 60_000;
const INSTALL_COMMAND_TIMEOUT_MS = 120_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 64 * 1024;
const REMOTE_CONFIGURATION_PATH = "/etc/autoforge-agent/config.json";
const REMOTE_CA_PATH = "/etc/autoforge-agent/control-plane-ca.pem";

type HostConnection = InstallRunnerAgentInput["connection"];

type ConnectedHost = {
  client: Client;
  hostKeySha256: string;
};

type InstallerDependencies = {
  resources: RunnerAgentResourceStore;
  controlPlaneUrl: string | undefined;
  issueBootstrapToken(): string;
};

export class RunnerAgentInstaller {
  constructor(private readonly dependencies: InstallerDependencies) {}

  async probe(connection: HostConnection): Promise<RunnerHostProbeResult> {
    return this.inspectHost(connection);
  }

  async install(input: InstallRunnerAgentInput): Promise<RunnerAgentInstallationResult> {
    const controlPlaneUrl = normalizeRunnerControlPlaneUrl(this.dependencies.controlPlaneUrl);
    const probe = await this.inspectHost(input.connection, input.expectedHostKeySha256);
    const resources = await this.dependencies.resources.read(probe.architecture);
    const temporaryDirectory = `/tmp/autoforge-install-${randomUUID()}`;
    const connected = await connectHost(input.connection, input.expectedHostKeySha256);
    try {
      const sftp = await openSftp(connected.client);
      await makeRemoteDirectory(sftp, temporaryDirectory);
      const uploaded = installationFiles({
        input,
        probe,
        resources,
        controlPlaneUrl,
        bootstrapToken: this.dependencies.issueBootstrapToken(),
        temporaryDirectory,
      });
      try {
        for (const file of uploaded) {
          await writeRemoteFile(sftp, file.path, file.content, file.mode);
          await verifyRemoteFile(sftp, file.path, file.content);
        }
        const command = installationCommand(
          temporaryDirectory,
          probe.privilegeMode,
          Boolean(input.caCertificatePem),
          input.runAsRoot,
        );
        await executeRemoteCommand(
          connected.client,
          command,
          probe.privilegeMode === "sudo" ? `${input.connection.password}\n` : undefined,
          INSTALL_COMMAND_TIMEOUT_MS,
        );
      } finally {
        await removeRemoteFiles(
          sftp,
          uploaded.map((file) => file.path),
          temporaryDirectory,
        );
      }
    } finally {
      connected.client.end();
    }
    return {
      installed: true,
      host: input.connection.host,
      operatingSystemName: probe.operatingSystemName,
      architecture: probe.architecture,
      agentVersion: resources.version,
      serviceName: "autoforge-agent.service",
    };
  }

  async rollback(input: RollbackRunnerAgentInput): Promise<RunnerAgentRollbackResult> {
    const probe = await this.inspectHost(input.connection, input.expectedHostKeySha256);
    const connected = await connectHost(input.connection, input.expectedHostKeySha256);
    try {
      const result = await executeRemoteCommand(
        connected.client,
        rollbackCommand(probe.privilegeMode),
        probe.privilegeMode === "sudo" ? `${input.connection.password}\n` : undefined,
        INSTALL_COMMAND_TIMEOUT_MS,
      );
      const version = parseRolledBackVersion(result.stdout);
      return {
        rolledBack: true,
        host: input.connection.host,
        agentVersion: version,
        serviceName: "autoforge-agent.service",
      };
    } finally {
      connected.client.end();
    }
  }

  private async inspectHost(
    connection: HostConnection,
    expectedHostKeySha256?: string,
  ): Promise<RunnerHostProbeResult> {
    const connected = await connectHost(connection, expectedHostKeySha256);
    try {
      const output = await executeRemoteCommand(
        connected.client,
        hostProbeCommand,
        `${connection.password}\n`,
        REMOTE_COMMAND_TIMEOUT_MS,
        runnerProbeCommandError,
      );
      return parseHostProbe(output.stdout, connected.hostKeySha256);
    } finally {
      connected.client.end();
    }
  }
}

const hostProbeCommand = `set -u
if ! test -r /etc/os-release; then
  printf "AUTOFORGE_PROBE_ERROR=OS_RELEASE_MISSING\\n" >&2
  exit 20
fi
. /etc/os-release
if ! command -v systemctl >/dev/null 2>&1; then
  printf "AUTOFORGE_PROBE_ERROR=SYSTEMD_REQUIRED\\n" >&2
  exit 21
fi
if test -r /sys/fs/cgroup/cgroup.controllers; then
  printf "CGROUP_V2=true\\n"
else
  printf "CGROUP_V2=false\\n"
fi
printf "OS_ID=%s\\n" "\${ID:-}"
printf "OS_NAME=%s\\n" "\${PRETTY_NAME:-\${NAME:-unknown}}"
printf "ARCH=%s\\n" "$(uname -m)"
if [ "$(id -u)" -eq 0 ]; then
  printf "PRIVILEGE=root\\n"
else
  if ! sudo_path="$(command -v sudo)"; then
    printf "AUTOFORGE_PROBE_ERROR=SUDO_MISSING\\n" >&2
    exit 23
  fi
  if ! "\${sudo_path}" -S -k -p "" true >/dev/null; then
    printf "AUTOFORGE_PROBE_ERROR=SUDO_REJECTED\\n" >&2
    exit 24
  fi
  printf "PRIVILEGE=sudo\\n"
fi`;

function parseHostProbe(output: string, hostKeySha256: string): RunnerHostProbeResult {
  const fields = new Map(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const operatingSystemId = fields.get("OS_ID");
  if (
    operatingSystemId !== "ubuntu" &&
    operatingSystemId !== "opensuse" &&
    operatingSystemId !== "opensuse-leap" &&
    operatingSystemId !== "opensuse-tumbleweed"
  ) {
    throw new DomainError(
      "RUNNER_HOST_UNSUPPORTED",
      `仅支持 Ubuntu 与 openSUSE，目标系统为 ${operatingSystemId || "未知"}。`,
    );
  }
  const architecture = normalizeArchitecture(fields.get("ARCH"));
  const privilege = fields.get("PRIVILEGE");
  if (privilege !== "root" && privilege !== "sudo") {
    throw new DomainError(
      "RUNNER_HOST_PRIVILEGE_REQUIRED",
      "SSH 用户必须是 root，或可使用相同密码执行 sudo。",
    );
  }
  return {
    hostKeySha256,
    operatingSystemId,
    operatingSystemName: fields.get("OS_NAME")?.slice(0, 128) || operatingSystemId,
    architecture,
    initSystem: "systemd",
    privilegeMode: privilege,
    cgroupV2Available: fields.get("CGROUP_V2") === "true",
  };
}

function normalizeArchitecture(value: string | undefined): AgentArchitecture {
  if (value === "x86_64" || value === "amd64") return "amd64";
  if (value === "aarch64" || value === "arm64") return "arm64";
  throw new DomainError(
    "RUNNER_HOST_UNSUPPORTED",
    `仅支持 amd64 与 arm64，目标架构为 ${value || "未知"}。`,
  );
}

export function normalizeRunnerControlPlaneUrl(value: string | undefined): string {
  if (!value) {
    throw new DomainError(
      "RUNNER_INSTALL_CONFIGURATION_REQUIRED",
      "自动安装 Agent 前，请在平台配置中设置执行机可访问的公网/内网 HTTP 或 HTTPS 地址。",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new DomainError(
      "RUNNER_INSTALL_CONFIGURATION_REQUIRED",
      "Agent 控制面地址不是有效 URL。",
      { cause },
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DomainError(
      "RUNNER_INSTALL_CONFIGURATION_REQUIRED",
      "Agent 控制面地址必须使用 HTTP 或 HTTPS。",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DomainError(
      "RUNNER_INSTALL_CONFIGURATION_REQUIRED",
      "Agent 控制面地址不能包含凭据、查询参数或片段。",
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function connectHost(
  connection: HostConnection,
  expectedHostKeySha256?: string,
): Promise<ConnectedHost> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let observedHostKey = "";
    let hostKeyMismatch = false;
    client.once("ready", () => resolve({ client, hostKeySha256: observedHostKey }));
    client.once("error", (error) => {
      client.end();
      reject(
        hostKeyMismatch
          ? new DomainError(
              "RUNNER_HOST_KEY_MISMATCH",
              "执行机 SSH 主机指纹已变化，安装已中止，请重新探测并核验。",
              { cause: error },
            )
          : runnerHostConnectionError(error),
      );
    });
    client.on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
      finish(prompts.map(() => connection.password));
    });
    client.connect({
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      tryKeyboard: true,
      readyTimeout: SSH_READY_TIMEOUT_MS,
      keepaliveInterval: 5_000,
      keepaliveCountMax: 3,
      hostVerifier: (hostKey: Buffer) => {
        observedHostKey = sshHostKeyFingerprint(hostKey);
        if (!expectedHostKeySha256) return true;
        const matches = secureEqual(observedHostKey, expectedHostKeySha256);
        hostKeyMismatch = !matches;
        return matches;
      },
    });
  });
}

function runnerHostConnectionError(error: Error): DomainError {
  const diagnostic = error as Error & { code?: string; level?: string };
  if (
    diagnostic.level === "client-authentication" ||
    diagnostic.message.includes("authentication methods failed")
  ) {
    return new DomainError(
      "RUNNER_HOST_AUTHENTICATION_FAILED",
      "SSH 认证被执行机拒绝，请确认用户名、密码，以及服务器是否允许密码或 Keyboard-Interactive/PAM 登录。",
      { cause: error },
    );
  }
  if (diagnostic.code === "ENOTFOUND" || diagnostic.code === "EAI_AGAIN") {
    return new DomainError(
      "RUNNER_HOST_DNS_FAILED",
      "无法解析执行机主机名，请检查 DNS 或改用可达的 IP 地址。",
      { cause: error },
    );
  }
  if (diagnostic.code === "ECONNREFUSED") {
    return new DomainError(
      "RUNNER_HOST_CONNECTION_REFUSED",
      "执行机拒绝 SSH 连接，请确认 SSH 服务已启动且端口填写正确。",
      { cause: error },
    );
  }
  if (diagnostic.code === "ETIMEDOUT" || diagnostic.level === "client-timeout") {
    return new DomainError(
      "RUNNER_HOST_CONNECTION_TIMEOUT",
      "连接执行机 SSH 超时，请检查平台到目标地址的路由、防火墙和安全组。",
      { cause: error },
    );
  }
  if (diagnostic.level === "handshake") {
    return new DomainError(
      "RUNNER_HOST_HANDSHAKE_FAILED",
      "SSH 握手失败，请检查服务端主机密钥与加密算法是否为当前 OpenSSH 支持的安全配置。",
      { cause: error },
    );
  }
  return new DomainError(
    "RUNNER_HOST_CONNECTION_FAILED",
    "无法通过 SSH 连接执行机，请检查地址、端口和网络连通性。",
    { cause: error },
  );
}

function sshHostKeyFingerprint(hostKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function executeRemoteCommand(
  client: Client,
  command: string,
  stdin: string | undefined,
  timeoutMs: number,
  commandError: (result: {
    stdout: string;
    stderr: string;
  }) => DomainError = remoteExecutionFailure,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(remoteCommandError(error));
        return;
      }
      collectCommandOutput(stream, stdin, timeoutMs, commandError).then(resolve, reject);
    });
  });
}

function collectCommandOutput(
  stream: ClientChannel,
  stdin: string | undefined,
  timeoutMs: number,
  commandError: (result: { stdout: string; stderr: string }) => DomainError,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.close();
      reject(new DomainError("RUNNER_HOST_COMMAND_TIMEOUT", "执行机操作超时。"));
    }, timeoutMs);
    const append = (chunks: Buffer[], chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += value.byteLength;
      if (totalBytes > MAXIMUM_COMMAND_OUTPUT_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          stream.close();
          reject(new DomainError("RUNNER_HOST_OUTPUT_LIMIT", "执行机命令输出超过安全上限。"));
        }
        return;
      }
      chunks.push(value);
    };
    stream.on("data", (chunk: Buffer | string) => append(stdout, chunk));
    stream.stderr.on("data", (chunk: Buffer | string) => append(stderr, chunk));
    stream.once("close", (exitCode: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (exitCode !== 0) {
        reject(commandError(result));
        return;
      }
      resolve(result);
    });
    stream.end(stdin);
  });
}

function runnerProbeCommandError(result: { stdout: string; stderr: string }): DomainError {
  const output = `${result.stderr}\n${result.stdout}`;
  const marker = output.match(/AUTOFORGE_PROBE_ERROR=([A-Z0-9_]+)/)?.[1];
  const diagnostics: Record<string, { code: string; message: string }> = {
    OS_RELEASE_MISSING: {
      code: "RUNNER_HOST_UNSUPPORTED",
      message: "执行机缺少可读取的 /etc/os-release，无法确认受支持的 Linux 发行版。",
    },
    SYSTEMD_REQUIRED: {
      code: "RUNNER_HOST_UNSUPPORTED",
      message: "执行机未提供 systemd/systemctl，当前自动安装仅支持 systemd 主机。",
    },
    CGROUP_V2_REQUIRED: {
      code: "RUNNER_HOST_UNSUPPORTED",
      message: "执行机探测脚本报告 cgroup v2 不可用；请升级主平台后使用降级隔离模式。",
    },
    SUDO_MISSING: {
      code: "RUNNER_HOST_PRIVILEGE_REQUIRED",
      message: "SSH 用户不是 root，且执行机未安装 sudo。",
    },
    SUDO_REJECTED: {
      code: "RUNNER_HOST_PRIVILEGE_REQUIRED",
      message:
        "SSH 登录成功，但相同密码无法通过无交互 sudo 校验；请检查 sudoers、密码和 requiretty 策略。",
    },
  };
  const diagnostic = marker ? diagnostics[marker] : undefined;
  return diagnostic
    ? new DomainError(diagnostic.code, diagnostic.message)
    : remoteExecutionFailure(result);
}

function remoteExecutionFailure(result: { stdout: string; stderr: string }): DomainError {
  return new DomainError(
    "RUNNER_INSTALLATION_FAILED",
    boundedRemoteFailure(result.stderr || result.stdout),
  );
}

function remoteCommandError(error: Error): DomainError {
  return new DomainError("RUNNER_INSTALLATION_FAILED", "无法在执行机上启动安装命令。", {
    cause: error,
  });
}

function boundedRemoteFailure(output: string): string {
  const normalized = output
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500);
  return normalized ? `执行机操作失败：${normalized}` : "执行机操作失败。";
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(remoteCommandError(error));
      else resolve(sftp);
    });
  });
}

function makeRemoteDirectory(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, { mode: 0o700 }, (error) => {
      if (error) reject(remoteCommandError(error));
      else resolve();
    });
  });
}

function writeRemoteFile(
  sftp: SFTPWrapper,
  path: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, content, { mode, flag: "wx" }, (error) => {
      if (error) reject(remoteCommandError(error));
      else resolve();
    });
  });
}

function readRemoteFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (error, content) => {
      if (error) reject(remoteCommandError(error));
      else resolve(content);
    });
  });
}

async function verifyRemoteFile(sftp: SFTPWrapper, path: string, expected: Buffer): Promise<void> {
  const actual = await readRemoteFile(sftp, path);
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actualDigest, expectedDigest)) {
    throw new DomainError("RUNNER_INSTALLATION_FAILED", "上传到执行机的安装资源校验失败。");
  }
}

async function removeRemoteFiles(
  sftp: SFTPWrapper,
  paths: string[],
  directory: string,
): Promise<void> {
  await Promise.allSettled(paths.map((path) => unlinkRemoteFile(sftp, path)));
  await new Promise<void>((resolve) => sftp.rmdir(directory, () => resolve()));
}

function unlinkRemoteFile(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

type InstallationFile = { path: string; content: Buffer; mode: number };

function installationFiles(input: {
  input: InstallRunnerAgentInput;
  probe: RunnerHostProbeResult;
  resources: RunnerAgentResources;
  controlPlaneUrl: string;
  bootstrapToken: string;
  temporaryDirectory: string;
}): InstallationFile[] {
  const configuration = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        serverUrl: input.controlPlaneUrl,
        dataDirectory: "/var/lib/autoforge-agent",
        name: input.input.name,
        labels: [...new Set(input.input.labels)],
        maxConcurrency: input.input.maxConcurrency,
        ...(input.input.caCertificatePem ? { caFile: REMOTE_CA_PATH } : {}),
        bootstrapToken: input.bootstrapToken,
        resources: input.probe.cgroupV2Available
          ? { cgroupRoot: "/sys/fs/cgroup/system.slice/autoforge-agent.service" }
          : {},
        terminal: {
          enabled: input.input.terminalEnabled,
          shell: "/bin/sh",
          maximumSessions: 1,
          maximumDuration: "1h",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const files: InstallationFile[] = [
    {
      path: `${input.temporaryDirectory}/autoforge-agent`,
      content: input.resources.binary,
      mode: 0o700,
    },
    {
      path: `${input.temporaryDirectory}/install.sh`,
      content: input.resources.installer,
      mode: 0o700,
    },
    {
      path: `${input.temporaryDirectory}/config.json`,
      content: configuration,
      mode: 0o600,
    },
    {
      path: `${input.temporaryDirectory}/autoforge-agent.service`,
      content: Buffer.from(renderAgentSystemdServiceUnit(input.input.runAsRoot), "utf8"),
      mode: 0o600,
    },
  ];
  if (input.input.caCertificatePem) {
    files.push({
      path: `${input.temporaryDirectory}/control-plane-ca.pem`,
      content: Buffer.from(input.input.caCertificatePem, "utf8"),
      mode: 0o600,
    });
  }
  return files;
}

function installationCommand(
  directory: string,
  privilegeMode: "root" | "sudo",
  includeCaCertificate: boolean,
  runAsRoot: boolean,
): string {
  const argumentsList = [
    `${directory}/install.sh`,
    `${directory}/autoforge-agent`,
    `${directory}/config.json`,
    `${directory}/autoforge-agent.service`,
    runAsRoot ? "root" : "autoforge-agent",
    ...(includeCaCertificate ? [`${directory}/control-plane-ca.pem`] : []),
  ].map(shellQuote);
  const command = `/bin/sh ${argumentsList.join(" ")}`;
  return privilegeMode === "sudo" ? `sudo -S -k -p '' ${command}` : command;
}

function rollbackCommand(privilegeMode: "root" | "sudo"): string {
  const command = `/bin/sh -c ${shellQuote(agentRollbackScript)}`;
  return privilegeMode === "sudo" ? `sudo -S -k -p '' ${command}` : command;
}

function parseRolledBackVersion(output: string): string {
  const marker = output
    .split("\n")
    .find((line) => line.startsWith("AUTOFORGE_ROLLED_BACK_VERSION="));
  const version = marker?.slice("AUTOFORGE_ROLLED_BACK_VERSION=".length).trim();
  if (!version || version.length > 128) {
    throw new DomainError(
      "RUNNER_ROLLBACK_FAILED",
      "执行机已响应回滚命令，但没有返回有效的 Agent 版本。",
    );
  }
  return version;
}

const agentRollbackScript = `set -eu
installed_binary=/opt/autoforge/bin/autoforge-agent
installed_configuration=/etc/autoforge-agent/config.json
installed_service_unit=/etc/systemd/system/autoforge-agent.service
backup_suffix=.autoforge-previous
rollback_suffix=.autoforge-rollback-current

for target in "$installed_binary" "$installed_configuration" "$installed_service_unit"; do
  if [ ! -f "$target$backup_suffix" ]; then
    echo "No complete previous Agent installation is available for rollback." >&2
    exit 31
  fi
done

restore_current() {
  for target in "$installed_binary" "$installed_configuration" "$installed_service_unit"; do
    failed_candidate="$target$backup_suffix"
    mv -f "$target" "$failed_candidate"
    mv -f "$target$rollback_suffix" "$target"
  done
  systemctl daemon-reload || true
  systemctl restart autoforge-agent.service || true
}

systemctl stop autoforge-agent.service
for target in "$installed_binary" "$installed_configuration" "$installed_service_unit"; do
  rm -f "$target$rollback_suffix"
  mv "$target" "$target$rollback_suffix"
  mv "$target$backup_suffix" "$target"
done
if ! systemctl daemon-reload ||
  ! systemctl restart autoforge-agent.service ||
  ! systemctl is-active --quiet autoforge-agent.service; then
  echo "Previous Agent failed its health check; restoring the current installation." >&2
  restore_current
  exit 32
fi
for target in "$installed_binary" "$installed_configuration" "$installed_service_unit"; do
  mv -f "$target$rollback_suffix" "$target$backup_suffix"
done
version_json="$($installed_binary version)"
version="$(printf '%s' "$version_json" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')"
if [ -z "$version" ]; then
  echo "Rolled back Agent did not report a version." >&2
  exit 33
fi
printf 'AUTOFORGE_ROLLED_BACK_VERSION=%s\n' "$version"`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderAgentSystemdServiceUnit(runAsRoot: boolean): string {
  const serviceUser = runAsRoot ? "root" : "autoforge-agent";
  return `[Unit]
Description=AutoForge Runner Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${serviceUser}
ExecStart=/opt/autoforge/bin/autoforge-agent start --config ${REMOTE_CONFIGURATION_PATH}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=45s
StateDirectory=autoforge-agent
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
RestrictSUIDSGID=true
Delegate=yes
TasksMax=2048
ReadWritePaths=/var/lib/autoforge-agent /etc/autoforge-agent

[Install]
WantedBy=multi-user.target
`;
}
