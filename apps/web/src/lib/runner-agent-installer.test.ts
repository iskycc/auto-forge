import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";

import { Server, type Connection } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  normalizeRunnerControlPlaneUrl,
  renderAgentSystemdServiceUnit,
  RunnerAgentInstaller,
} from "./runner-agent-installer";
import { RunnerAgentResourceStore } from "./runner-agent-resources";

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
        "CGROUP_V2=false\nOS_ID=ubuntu\nOS_NAME=Ubuntu 24.04 LTS\nARCH=x86_64\nPRIVILEGE=root\n",
    });
    const address = server.address() as AddressInfo;

    await expect(installer().probe(connection(address.port))).resolves.toMatchObject({
      privilegeMode: "root",
      cgroupV2Available: false,
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
      target.rollback({ connection: host, expectedHostKeySha256: probe.hostKeySha256 }),
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
  "CGROUP_V2=true\nOS_ID=ubuntu\nOS_NAME=Ubuntu 24.04 LTS\nARCH=x86_64\nPRIVILEGE=sudo\n";

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
