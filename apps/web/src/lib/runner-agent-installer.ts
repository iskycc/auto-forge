import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  InstallRunnerAgentInput,
  RunnerAgentInstallationResult,
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
    const controlPlaneUrl = validatedControlPlaneUrl(this.dependencies.controlPlaneUrl);
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
      );
      return parseHostProbe(output.stdout, connected.hostKeySha256);
    } finally {
      connected.client.end();
    }
  }
}

const hostProbeCommand = `set -eu
test -r /etc/os-release
. /etc/os-release
command -v systemctl >/dev/null 2>&1
test -r /sys/fs/cgroup/cgroup.controllers
printf "OS_ID=%s\\n" "\${ID:-}"
printf "OS_NAME=%s\\n" "\${PRETTY_NAME:-\${NAME:-unknown}}"
printf "ARCH=%s\\n" "$(uname -m)"
if [ "$(id -u)" -eq 0 ]; then
  printf "PRIVILEGE=root\\n"
else
  sudo_path="$(command -v sudo)"
  "\${sudo_path}" -S -k -p "" true >/dev/null
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

function validatedControlPlaneUrl(value: string | undefined): string {
  if (!value) {
    throw new DomainError(
      "RUNNER_INSTALL_CONFIGURATION_REQUIRED",
      "自动安装 Agent 前，请在平台配置中设置执行机可访问的公网/内网 HTTPS 地址。",
    );
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopbackUrl(url)) {
    throw new DomainError(
      "RUNNER_INSTALL_CONFIGURATION_REQUIRED",
      "Agent 控制面地址必须使用 HTTPS；HTTP 仅允许本机开发地址。",
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function isLoopbackUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
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
          : new DomainError(
              "RUNNER_HOST_CONNECTION_FAILED",
              "无法通过 SSH 连接执行机，请检查地址、端口、用户名与密码。",
              { cause: error },
            ),
      );
    });
    client.connect({
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
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
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(remoteCommandError(error));
        return;
      }
      collectCommandOutput(stream, stdin, timeoutMs).then(resolve, reject);
    });
  });
}

function collectCommandOutput(
  stream: ClientChannel,
  stdin: string | undefined,
  timeoutMs: number,
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
        reject(
          new DomainError(
            "RUNNER_INSTALLATION_FAILED",
            boundedRemoteFailure(result.stderr || result.stdout),
          ),
        );
        return;
      }
      resolve(result);
    });
    stream.end(stdin);
  });
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
        resources: { cgroupRoot: "/sys/fs/cgroup/system.slice/autoforge-agent.service" },
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
      content: Buffer.from(systemdServiceUnit, "utf8"),
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
): string {
  const argumentsList = [
    `${directory}/install.sh`,
    `${directory}/autoforge-agent`,
    `${directory}/config.json`,
    `${directory}/autoforge-agent.service`,
    ...(includeCaCertificate ? [`${directory}/control-plane-ca.pem`] : []),
  ].map(shellQuote);
  const command = `/bin/sh ${argumentsList.join(" ")}`;
  return privilegeMode === "sudo" ? `sudo -S -k -p '' ${command}` : command;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const systemdServiceUnit = `[Unit]
Description=AutoForge Runner Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=autoforge-agent
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
