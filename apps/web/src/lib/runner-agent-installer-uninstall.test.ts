import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Server, type SFTPWrapper, utils } from "ssh2";
vi.mock("server-only", () => ({}));
import { RunnerAgentInstaller } from "./runner-agent-installer";
import { RunnerAgentResourceStore } from "./runner-agent-resources";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  format: "pem",
  type: "pkcs1",
});
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

async function host(fail?: "inspect" | "remove") {
  const files = new Map<string, Buffer>();
  const actions: string[] = [];
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.password === "fixture-password")
        context.accept();
      else context.reject();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (accept) => configureFiles(accept(), files));
        session.on("exec", (accept, _reject, metadata) => {
          const stream = accept();
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
    controlPlaneUrl: () => undefined,
    issueBootstrapToken: () => {
      throw new Error("Uninstall must not issue registration credentials");
    },
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
    input: {
      connection,
      installationMode: "auto" as const,
      expectedHostKeySha256: `SHA256:${"A".repeat(43)}`,
    },
  };
}

function configureFiles(sftp: SFTPWrapper, files: Map<string, Buffer>) {
  const status = utils.sftp.STATUS_CODE;
  sftp.on("MKDIR", (id) => sftp.status(id, status.OK));
  sftp.on("OPEN", (id, path, flags) => {
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
    files.delete(path);
    sftp.status(id, status.OK);
  });
  sftp.on("RMDIR", (id) => sftp.status(id, status.OK));
}
