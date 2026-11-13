import { createHash, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Server, type SFTPWrapper, utils } from "ssh2";
import type { Runner } from "@autoforge/domain";
vi.mock("server-only", () => ({}));
import { RunnerAgentInstaller } from "./runner-agent-installer";
import { RunnerAgentResourceStore } from "./runner-agent-resources";
import { mapApiError } from "./api-error-mapping";
import { updateRunnerAgent, upgradeRunnerAgent } from "./runner-agent-update";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  format: "pem",
  type: "pkcs1",
});
const parsedHostKey = utils.parseKey(privateKey);
if (parsedHostKey instanceof Error) throw parsedHostKey;
const hostFingerprint = `SHA256:${createHash("sha256").update(parsedHostKey.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("SSH Agent uninstall transfer", () => {
  it("verifies the uploaded tool, inspects identity, revokes and removes in order, then cleans temporary files", async () => {
    const fixture = await host();
    const revoke = vi.fn(async () => {
      fixture.actions.push("revoke");
    });
    const probe = await fixture.installer.probe(fixture.connection);
    await expect(
      fixture.installer.uninstall(
        { ...fixture.input, expectedHostKeySha256: probe.hostKeySha256 },
        "runner-one",
        revoke,
      ),
    ).resolves.toMatchObject({ uninstalled: true, dataDirectory: "/data/agent" });
    expect(fixture.actions).toEqual(["inspect", "revoke", "remove"]);
    expect(fixture.files.size).toBe(0);
  });
  it("rejects a mismatching installed identity before revocation and still removes its temporary tool", async () => {
    const fixture = await host("inspect");
    const revoke = vi.fn();
    const probe = await fixture.installer.probe(fixture.connection);
    await expect(
      fixture.installer.uninstall(
        { ...fixture.input, expectedHostKeySha256: probe.hostKeySha256 },
        "runner-one",
        revoke,
      ),
    ).rejects.toMatchObject({
      code: "RUNNER_INSTALLATION_FAILED",
      message: expect.stringContaining("identity mismatch"),
    });
    expect(revoke).not.toHaveBeenCalled();
    expect(fixture.files.size).toBe(0);
  });
  it("returns remote cleanup errors after revocation and releases temporary resources", async () => {
    const fixture = await host("remove");
    const probe = await fixture.installer.probe(fixture.connection);
    const revoke = vi.fn(async () => {});
    await expect(
      fixture.installer.uninstall(
        { ...fixture.input, expectedHostKeySha256: probe.hostKeySha256 },
        "runner-one",
        revoke,
      ),
    ).rejects.toMatchObject({ code: "RUNNER_INSTALLATION_FAILED" });
    expect(revoke).toHaveBeenCalledOnce();
    expect(fixture.files.size).toBe(0);
  });
});

describe("SSH Agent update transfer", () => {
  it.each(["update", "upgrade", "uninstall"] as const)(
    "completes %s when SSH permits only one session per connection",
    async (operation) => {
      const fixture = await host(undefined, { maximumSessions: 1 });
      const probe = await fixture.installer.probe(fixture.connection);
      const input = { ...fixture.input, expectedHostKeySha256: probe.hostKeySha256 };
      if (operation === "update") {
        await expect(
          updateRunnerAgent(fixture.installer, runnerFixture(), {
            ...input,
            dataDirectory: "/data/autoforge-agent",
            runAsRoot: true,
          }),
        ).resolves.toMatchObject({ installed: true, dataDirectory: "/data/autoforge-agent" });
      } else if (operation === "upgrade") {
        await expect(
          upgradeRunnerAgent(fixture.installer, runnerFixture(), input),
        ).resolves.toMatchObject({ installed: true });
      } else {
        await expect(
          fixture.installer.uninstall(input, "runner-one", async () => {}),
        ).resolves.toMatchObject({ uninstalled: true });
      }
      expect(fixture.files.size).toBe(0);
    },
  );

  it("identifies an unavailable SFTP subsystem instead of claiming the install command failed", async () => {
    const fixture = await host(undefined, { rejectSftp: true });
    await expect(fixture.installer.upgrade(fixture.input)).rejects.toMatchObject({
      code: "RUNNER_INSTALLATION_FAILED",
      message: expect.stringContaining("SFTP"),
      details: { stage: "sftp.open" },
    });
  });

  it("retries transient channel rejection after transfer without executing the upgrade twice", async () => {
    const fixture = await host(undefined, { maximumSessions: 1, delayedSessionRelease: 2 });
    await expect(fixture.installer.upgrade(fixture.input)).resolves.toMatchObject({
      installed: true,
    });
    expect(fixture.statistics.rejectedSessions).toBe(2);
    expect(fixture.statistics.upgradeCommands).toBe(1);
    expect(fixture.files.size).toBe(0);
  });

  it("bounds retries when the server permanently refuses session opens", async () => {
    const fixture = await host(undefined, { maximumSessions: 0 });
    await expect(fixture.installer.probe(fixture.connection)).rejects.toMatchObject({
      code: "RUNNER_INSTALLATION_FAILED",
      details: { stage: "ssh.exec", remoteReason: 2 },
    });
    expect(fixture.statistics.rejectedSessions).toBe(5);
  });

  it.each([
    ["mkdir", "创建临时安装目录", "sftp.mkdir"],
    ["write", "上传安装文件", "sftp.write"],
    ["read", "读取安装文件", "sftp.read"],
  ] as const)(
    "reports permission denied during %s with the actual stage",
    async (fileFailure, message, stage) => {
      const fixture = await host(undefined, { fileFailure });
      await expect(fixture.installer.upgrade(fixture.input)).rejects.toMatchObject({
        code: "RUNNER_INSTALLATION_FAILED",
        message: expect.stringContaining(message),
        details: { stage, remoteCode: 3 },
      });
      expect(fixture.files.size).toBe(0);
    },
  );
  it("reports a rejected exec request and removes already uploaded resources", async () => {
    const fixture = await host(undefined, { rejectCommand: true });
    await expect(fixture.installer.upgrade(fixture.input)).rejects.toMatchObject({
      code: "RUNNER_INSTALLATION_FAILED",
      message: expect.stringContaining("启动远程命令"),
      details: { stage: "ssh.exec" },
    });
    expect(fixture.files.size).toBe(0);
  });

  it("preserves the upload failure when subsequent temporary file cleanup also fails", async () => {
    const fixture = await host(undefined, { fileFailure: "read", rejectCleanup: true });
    await expect(fixture.installer.upgrade(fixture.input)).rejects.toMatchObject({
      code: "RUNNER_INSTALLATION_FAILED",
      message: expect.stringContaining("后续清理也失败"),
      details: { stage: "sftp.read", remoteCode: 3, cleanupFailed: true },
      cause: { details: { stage: "sftp.read" } },
    });
  });

  it("passes disk exhaustion diagnostics through the API without exposing credentials or causes", async () => {
    const fixture = await host(undefined, {
      fileFailure: "write",
      fileError: { code: 4, message: "No space left on device password=fixture-secret" },
    });
    const failure = await fixture.installer.upgrade(fixture.input).catch((error: unknown) => error);
    const response = mapApiError(failure, "update-request");
    expect(response).toMatchObject({
      status: 502,
      body: {
        error: {
          code: "RUNNER_INSTALLATION_FAILED",
          message: expect.stringContaining("空间、inode 和配额"),
          details: { stage: "sftp.write", remoteCode: 4 },
          requestId: "update-request",
        },
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/fixture-secret|"cause"|"stack"/);
    expect(fixture.files.size).toBe(0);
  });
});

type HostOptions = {
  maximumSessions?: number;
  rejectSftp?: boolean;
  fileFailure?: "mkdir" | "write" | "read";
  fileError?: { code: number; message: string };
  rejectCleanup?: boolean;
  rejectCommand?: boolean;
  delayedSessionRelease?: number;
};

function runnerFixture(): Runner {
  return {
    id: "runner-one",
    name: "updated-runner",
    state: "online",
    os: "linux",
    architecture: "amd64",
    agentVersion: "0.2.1",
    protocolVersion: 1,
    labels: [],
    capabilities: [],
    maxConcurrency: 2,
    busySlots: 0,
    lastSeenAt: "2026-11-13T00:00:00.000Z",
    terminalEnabled: false,
    credentialVersion: 1,
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
  };
}

async function host(fail?: "inspect" | "remove", options: HostOptions = {}) {
  const files = new Map<string, Buffer>();
  const actions: string[] = [];
  const statistics = { rejectedSessions: 0, upgradeCommands: 0 };
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.password === "fixture-password")
        context.accept();
      else context.reject();
    });
    let activeSessions = 0;
    let uploadedFilesClosed = false;
    let delayedSessionRejections = 0;
    client.on("ready", () =>
      client.on("session", (accept, reject) => {
        const releasingSession =
          uploadedFilesClosed && delayedSessionRejections < (options.delayedSessionRelease ?? 0);
        if (activeSessions >= (options.maximumSessions ?? Infinity) || releasingSession) {
          if (releasingSession) delayedSessionRejections++;
          statistics.rejectedSessions++;
          reject();
          return;
        }
        activeSessions++;
        const session = accept();
        session.on("sftp", (accept, reject) => {
          if (options.rejectSftp) {
            activeSessions--;
            reject();
            return;
          }
          const sftp = accept();
          sftp.once("close", () => {
            activeSessions--;
            uploadedFilesClosed = true;
            sftp.end();
          });
          configureFiles(sftp, files, options);
        });
        session.on("exec", (accept, reject, metadata) => {
          if (metadata.command.includes("candidate_binary=")) statistics.upgradeCommands++;
          if (options.rejectCommand && !metadata.command.includes("OS_ID=")) {
            activeSessions--;
            reject();
            return;
          }
          const stream = accept();
          stream.resume();
          const action = metadata.command.includes(" --inspect")
            ? "inspect"
            : metadata.command.includes(" --confirm")
              ? "remove"
              : undefined;
          if (action) actions.push(action);
          if (action && action === fail) {
            stream.stderr.write(action === "inspect" ? "identity mismatch" : "cleanup failed");
            stream.exit(41);
          } else {
            stream.write(
              action === "remove"
                ? JSON.stringify({
                    uninstalled: true,
                    dataDirectory: "/data/agent",
                    dataDirectoryRetained: false,
                  })
                : action === "inspect"
                  ? JSON.stringify({
                      schemaVersion: 1,
                      runnerId: "runner-one",
                      dataDirectory: "/data/agent",
                    })
                  : "CGROUP_V2=false\nOS_ID=ubuntu\nOS_NAME=Ubuntu\nARCH=x86_64\nBASH_PATH=/bin/bash\nPRIVILEGE=root\n",
            );
            stream.exit(0);
          }
          // The fixture command has exited and no longer occupies a shell session.
          activeSessions--;
          stream.end();
        });
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const store = new RunnerAgentResourceStore("/unused");
  vi.spyOn(store, "read").mockResolvedValue({
    version: "0.2.2",
    revision: "fixture",
    binary: Buffer.from("verified-offline-uninstall-tool"),
    adapter: Buffer.from("adapter"),
    installer: Buffer.from("installer"),
  });
  const installer = new RunnerAgentInstaller({
    resources: store,
    controlPlaneUrl: () => "http://autoforge.internal",
    issueBootstrapToken: () => "one-time-installation-token",
  });
  const connection = {
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    username: "root",
    password: "fixture-password",
  };
  return {
    installer,
    connection,
    files,
    actions,
    statistics,
    input: {
      connection,
      installationMode: "auto" as const,
      expectedHostKeySha256: hostFingerprint,
    },
  };
}

function configureFiles(sftp: SFTPWrapper, files: Map<string, Buffer>, options: HostOptions) {
  const status = utils.sftp.STATUS_CODE;
  const failure = options.fileFailure;
  sftp.on("MKDIR", (id) =>
    sftp.status(id, failure === "mkdir" ? status.PERMISSION_DENIED : status.OK),
  );
  sftp.on("OPEN", (id, path, flags) => {
    if (failure === (flags & utils.sftp.OPEN_MODE.CREAT ? "write" : "read")) {
      sftp.status(
        id,
        options.fileError?.code ?? status.PERMISSION_DENIED,
        options.fileError?.message,
      );
      return;
    }
    if (flags & utils.sftp.OPEN_MODE.CREAT) files.set(path, Buffer.alloc(0));
    if (!files.has(path)) {
      sftp.status(id, status.NO_SUCH_FILE);
      return;
    }
    sftp.handle(id, Buffer.from(path));
  });
  sftp.on("WRITE", (id, handle, offset, chunk) => {
    const path = handle.toString();
    const previous = files.get(path) ?? Buffer.alloc(0);
    const content = Buffer.alloc(Math.max(previous.length, offset + chunk.length));
    previous.copy(content);
    chunk.copy(content, offset);
    files.set(path, content);
    sftp.status(id, status.OK);
  });
  sftp.on("FSTAT", (id, handle) =>
    sftp.attrs(id, {
      size: files.get(handle.toString())?.length ?? 0,
      uid: 0,
      gid: 0,
      mode: 0o100700,
      atime: 0,
      mtime: 0,
    }),
  );
  sftp.on("READ", (id, handle, offset, length) => {
    const content = files.get(handle.toString()) ?? Buffer.alloc(0);
    if (offset >= content.length) sftp.status(id, status.EOF);
    else sftp.data(id, content.subarray(offset, offset + length));
  });
  sftp.on("CLOSE", (id) => sftp.status(id, status.OK));
  sftp.on("REMOVE", (id, path) => {
    if (options.rejectCleanup) {
      sftp.status(id, status.PERMISSION_DENIED);
      return;
    }
    files.delete(path);
    sftp.status(id, status.OK);
  });
  sftp.on("RMDIR", (id) => sftp.status(id, status.OK));
}
