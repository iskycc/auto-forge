import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  DEFAULT_RUNNER_DATA_DIRECTORY,
  installRunnerAgentInputSchema,
  type InstallRunnerAgentInput,
  type RunnerHostProbeResult,
} from "@autoforge/contracts";
import { Server, type Connection } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  installationFiles,
  normalizeRunnerControlPlaneUrl,
  parseRemoteDataDirectory,
  renderAgentSystemdServiceUnit,
  resolveRunnerDataDirectory,
  RunnerAgentInstaller,
} from "./runner-agent-installer";
import { RunnerAgentResourceStore, type RunnerAgentResources } from "./runner-agent-resources";

const hostPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  format: "pem",
  type: "pkcs1",
});
const openServers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...openServers].map(closeServer));
  openServers.clear();
});

describe("RunnerAgentInstaller SSH probe", () => {
  it("supports password authentication exposed through keyboard-interactive/PAM", async () => {
    const server = await startProbeServer({ authentication: "keyboard-interactive" });
    const address = server.address() as AddressInfo;

    await expect(installer().probe(connection(address.port))).resolves.toMatchObject({
      operatingSystemId: "ubuntu",
      architecture: "amd64",
      privilegeMode: "sudo",
    });
  });

  it("reports rejected credentials separately from network failures", async () => {
    const server = await startProbeServer({ authentication: "reject" });
    const address = server.address() as AddressInfo;

    await expect(
      installer().probe({
        host: "127.0.0.1",
        port: address.port,
        username: "runner-admin",
        password: "wrong-password",
      }),
    ).rejects.toMatchObject({ code: "RUNNER_HOST_AUTHENTICATION_FAILED" });
  });

  it("keeps standard SSH password authentication compatible", async () => {
    const server = await startProbeServer({ authentication: "password" });
    const address = server.address() as AddressInfo;

    await expect(installer().probe(connection(address.port))).resolves.toMatchObject({
      operatingSystemId: "ubuntu",
      architecture: "amd64",
    });
  });

  it("reports missing cgroup v2 as an available degraded mode", async () => {
    const server = await startProbeServer({
      authentication: "password",
      commandOutput:
        "CGROUP_V2=false\nOS_ID=ubuntu\nOS_ID_LIKE=debian\nOS_NAME=Ubuntu 24.04 LTS\nARCH=x86_64\nBASH_PATH=/bin/bash\nPRIVILEGE=root\n",
    });
    const address = server.address() as AddressInfo;

    await expect(installer().probe(connection(address.port))).resolves.toMatchObject({
      privilegeMode: "root",
      cgroupV2Available: false,
    });
  });

  it("recognizes openSUSE evidence when os-release reports sles", async () => {
    const server = await startProbeServer({
      authentication: "password",
      commandOutput:
        "CGROUP_V2=true\nOS_ID=sles\nOS_ID_LIKE=suse\nOS_NAME=openSUSE Leap 15.6\nARCH=x86_64\nBASH_PATH=/usr/bin/bash\nPRIVILEGE=root\n",
    });
    const address = server.address() as AddressInfo;

    await expect(installer().probe(connection(address.port))).resolves.toMatchObject({
      operatingSystemId: "opensuse-leap",
      detectedOperatingSystemId: "sles",
      forcedInstallationMode: false,
      bashPath: "/usr/bin/bash",
    });
  });

  it("allows an explicit mode when automatic system detection is unsupported", async () => {
    const server = await startProbeServer({
      authentication: "password",
      commandOutput:
        "CGROUP_V2=true\nOS_ID=sles\nOS_NAME=SUSE Linux Enterprise\nARCH=x86_64\nBASH_PATH=/bin/bash\nPRIVILEGE=root\n",
    });
    const address = server.address() as AddressInfo;

    await expect(installer().probe(connection(address.port), "opensuse")).resolves.toMatchObject({
      operatingSystemId: "opensuse",
      detectedOperatingSystemId: "sles",
      forcedInstallationMode: true,
    });
  });

  it("uses the verified host key and reports the health-checked rollback version", async () => {
    const server = await startProbeServer({
      authentication: "password",
      commandResults: [
        { output: probeOutput, exitCode: 0 },
        { output: probeOutput, exitCode: 0 },
        { output: "AUTOFORGE_ROLLED_BACK_VERSION=0.3.3\n", exitCode: 0 },
      ],
    });
    const address = server.address() as AddressInfo;
    const target = installer();
    const host = connection(address.port);
    const probe = await target.probe(host);

    await expect(
      target.rollback({
        connection: host,
        expectedHostKeySha256: probe.hostKeySha256,
        installationMode: "auto",
      }),
    ).resolves.toMatchObject({ rolledBack: true, agentVersion: "0.3.3" });
  });
});

describe("Runner Agent installation policy", () => {
  it("accepts an internal HTTP control plane address", () => {
    expect(normalizeRunnerControlPlaneUrl("http://10.20.30.40:3000/")).toBe(
      "http://10.20.30.40:3000",
    );
    expect(() => normalizeRunnerControlPlaneUrl("ftp://10.20.30.40")).toThrow(
      "必须使用 HTTP 或 HTTPS",
    );
    expect(() => normalizeRunnerControlPlaneUrl("http://user:secret@10.20.30.40")).toThrow(
      "不能包含凭据",
    );
  });

  it("can render a root-owned Agent service without changing the default", () => {
    expect(renderAgentSystemdServiceUnit(true)).toContain("\nUser=root\n");
    expect(renderAgentSystemdServiceUnit(false)).toContain("\nUser=autoforge-agent\n");
    expect(renderAgentSystemdServiceUnit(false)).toContain(
      "\nWorkingDirectory=/var/lib/autoforge-agent\n",
    );
    expect(renderAgentSystemdServiceUnit(false)).toContain("\nStateDirectory=autoforge-agent\n");
  });

  it("points the systemd unit at a custom data directory without StateDirectory", () => {
    const unit = renderAgentSystemdServiceUnit(false, "/data/autoforge-agent");
    expect(unit).toContain("\nWorkingDirectory=/data/autoforge-agent\n");
    expect(unit).toContain("\nReadWritePaths=/data/autoforge-agent /etc/autoforge-agent\n");
    expect(unit).not.toContain("StateDirectory=");
  });

  it("defaults an omitted data directory to the standard directory", () => {
    expect(resolveRunnerDataDirectory(undefined)).toBe(DEFAULT_RUNNER_DATA_DIRECTORY);
    expect(resolveRunnerDataDirectory("  /data/agent  ")).toBe("/data/agent");
    expect(() => resolveRunnerDataDirectory("relative")).toThrow("必须是绝对路径");
  });

  it("writes the requested data directory into the generated Agent configuration", () => {
    const files = installationFiles({
      input: baseInstallInput({ dataDirectory: "/data/autoforge-agent" }),
      probe: probeResult,
      resources: stubResources(),
      controlPlaneUrl: "https://autoforge.internal",
      dataDirectory: "/data/autoforge-agent",
      bootstrapToken: "one-time-token",
      temporaryDirectory: "/tmp/autoforge-install-1",
    });
    const configuration = files.find((file) => file.path.endsWith("/config.json"));
    expect(configuration).toBeDefined();
    const rendered = JSON.parse(configuration!.content.toString("utf8"));
    expect(rendered.dataDirectory).toBe("/data/autoforge-agent");
    const unit = files.find((file) => file.path.endsWith("/autoforge-agent.service"));
    expect(unit!.content.toString("utf8")).toContain("WorkingDirectory=/data/autoforge-agent\n");
  });

  it("keeps the default data directory when the installation does not customize it", () => {
    const files = installationFiles({
      input: baseInstallInput({}),
      probe: probeResult,
      resources: stubResources(),
      controlPlaneUrl: "https://autoforge.internal",
      dataDirectory: DEFAULT_RUNNER_DATA_DIRECTORY,
      bootstrapToken: "one-time-token",
      temporaryDirectory: "/tmp/autoforge-install-1",
    });
    const configuration = files.find((file) => file.path.endsWith("/config.json"));
    const rendered = JSON.parse(configuration!.content.toString("utf8"));
    expect(rendered.dataDirectory).toBe(DEFAULT_RUNNER_DATA_DIRECTORY);
    const unit = files.find((file) => file.path.endsWith("/autoforge-agent.service"));
    expect(unit!.content.toString("utf8")).toContain("StateDirectory=autoforge-agent\n");
  });

  it("preserves a previously configured data directory when reading remote state", () => {
    const configured = Buffer.from(
      JSON.stringify({ schemaVersion: 1, dataDirectory: "/data/autoforge-agent" }),
      "utf8",
    );
    expect(parseRemoteDataDirectory(configured)).toBe("/data/autoforge-agent");
    expect(parseRemoteDataDirectory(Buffer.from("{}", "utf8"))).toBe(DEFAULT_RUNNER_DATA_DIRECTORY);
    expect(parseRemoteDataDirectory(Buffer.from("not-json", "utf8"))).toBe(
      DEFAULT_RUNNER_DATA_DIRECTORY,
    );
    const invalid = Buffer.from(JSON.stringify({ dataDirectory: "/data/../etc" }), "utf8");
    expect(() => parseRemoteDataDirectory(invalid)).toThrow("必须是绝对路径");
  });
});

describe("RunnerAgentInstaller remote configuration read-back", () => {
  it("keeps the custom directory reported by the installed Agent configuration", async () => {
    const configuration = JSON.stringify({ schemaVersion: 1, dataDirectory: "/data/runner" });
    const server = await startProbeServer({
      authentication: "password",
      commandOutput: configuration,
    });
    const address = server.address() as AddressInfo;

    await expect(installer().readRemoteDataDirectory(connection(address.port))).resolves.toBe(
      "/data/runner",
    );
  });

  it("falls back to the default directory when no configuration exists yet", async () => {
    const server = await startProbeServer({ authentication: "password" });
    const address = server.address() as AddressInfo;

    await expect(installer().readRemoteDataDirectory(connection(address.port))).resolves.toBe(
      DEFAULT_RUNNER_DATA_DIRECTORY,
    );
  });

  it("fails when the remote configuration contains an invalid data directory", async () => {
    const configuration = JSON.stringify({ schemaVersion: 1, dataDirectory: "/data/../etc" });
    const server = await startProbeServer({
      authentication: "password",
      commandOutput: configuration,
    });
    const address = server.address() as AddressInfo;

    await expect(
      installer().readRemoteDataDirectory(connection(address.port)),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

type ProbeAuthentication = "keyboard-interactive" | "password" | "reject";
type ProbeServerOptions = {
  authentication: ProbeAuthentication;
  commandOutput?: string;
  commandExitCode?: number;
  commandResults?: Array<{ output: string; exitCode: number }>;
};

const probeOutput =
  "CGROUP_V2=true\nOS_ID=ubuntu\nOS_ID_LIKE=debian\nOS_NAME=Ubuntu 24.04 LTS\nARCH=x86_64\nBASH_PATH=/bin/bash\nPRIVILEGE=sudo\n";

async function startProbeServer(options: ProbeServerOptions): Promise<Server> {
  let commandInvocation = 0;
  const server = new Server({ hostKeys: [hostPrivateKey] }, (client) => {
    configureAuthentication(client, options.authentication);
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptCommand) => {
          const stream = acceptCommand();
          const result = options.commandResults?.[commandInvocation++];
          stream.write(result?.output ?? options.commandOutput ?? probeOutput);
          stream.exit(result?.exitCode ?? options.commandExitCode ?? 0);
          stream.end();
        });
      });
    });
  });
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function configureAuthentication(client: Connection, authentication: ProbeAuthentication): void {
  client.on("authentication", (context) => {
    if (
      authentication === "password" &&
      context.method === "password" &&
      context.password === "correct-password"
    ) {
      context.accept();
      return;
    }
    if (authentication === "keyboard-interactive" && context.method === "keyboard-interactive") {
      context.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
        if (answers[0] === "correct-password") context.accept();
        else context.reject();
      });
      return;
    }
    context.reject(authentication === "keyboard-interactive" ? ["keyboard-interactive"] : []);
  });
}

function installer(): RunnerAgentInstaller {
  return new RunnerAgentInstaller({
    resources: new RunnerAgentResourceStore("/unused"),
    controlPlaneUrl: "https://autoforge.internal",
    issueBootstrapToken: () => "unused",
  });
}

function connection(port: number) {
  return {
    host: "127.0.0.1",
    port,
    username: "runner-admin",
    password: "correct-password",
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const probeResult: RunnerHostProbeResult = {
  hostKeySha256: `SHA256:${"a".repeat(43)}`,
  operatingSystemId: "ubuntu",
  detectedOperatingSystemId: "ubuntu",
  operatingSystemName: "Ubuntu 24.04 LTS",
  architecture: "amd64",
  initSystem: "systemd",
  privilegeMode: "sudo",
  cgroupV2Available: true,
  bashPath: "/bin/bash",
  forcedInstallationMode: false,
};

function baseInstallInput(overrides: Partial<InstallRunnerAgentInput>): InstallRunnerAgentInput {
  return installRunnerAgentInputSchema.parse({
    connection: {
      host: "10.20.30.40",
      port: 22,
      username: "runner-admin",
      password: "correct-password",
    },
    expectedHostKeySha256: `SHA256:${"a".repeat(43)}`,
    name: "runner-west-1",
    ...overrides,
  });
}

function stubResources(): RunnerAgentResources {
  return {
    version: "0.3.3",
    revision: "revision",
    binary: Buffer.from("agent-binary"),
    installer: Buffer.from("installer"),
    adapter: Buffer.from("adapter"),
  };
}
