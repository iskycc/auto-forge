import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunnerAgentResourceStore } from "./runner-agent-resources";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RunnerAgentResourceStore", () => {
  it("loads only resources matching the versioned manifest", async () => {
    const directory = await resourceDirectory();
    const resources = await new RunnerAgentResourceStore(directory).read("amd64");
    expect(resources.version).toBe("1.2.3");
    expect(resources.binary.toString()).toBe("amd64-agent");
    expect(resources.installer.toString()).toBe("installer");
    expect(resources.adapter.toString()).toBe("adapter");
  });

  it("rejects a modified embedded binary", async () => {
    const directory = await resourceDirectory();
    await writeFile(join(directory, "linux-amd64/autoforge-agent"), "modified");
    await expect(new RunnerAgentResourceStore(directory).read("amd64")).rejects.toMatchObject({
      code: "RUNNER_AGENT_RESOURCE_INVALID",
    });
  });

  it("reports the bundled version without reading binaries", async () => {
    const directory = await resourceDirectory();
    await expect(new RunnerAgentResourceStore(directory).version()).resolves.toBe("1.2.3");
  });

  it("maps a missing manifest to an unavailable-resource error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-agent-store-"));
    temporaryDirectories.push(directory);
    await expect(new RunnerAgentResourceStore(directory).version()).rejects.toMatchObject({
      code: "RUNNER_AGENT_RESOURCE_UNAVAILABLE",
    });
  });
});

async function resourceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-agent-store-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "linux-amd64"));
  await mkdir(join(directory, "linux-arm64"));
  const files = {
    "linux-amd64": resource("linux-amd64/autoforge-agent", "amd64-agent"),
    "linux-arm64": resource("linux-arm64/autoforge-agent", "arm64-agent"),
    installer: resource("install.sh", "installer"),
    adapter: resource("cotest-testng-adapter.jar", "adapter"),
  };
  await writeFile(join(directory, files["linux-amd64"].path), "amd64-agent");
  await writeFile(join(directory, files["linux-arm64"].path), "arm64-agent");
  await writeFile(join(directory, files.installer.path), "installer");
  await writeFile(join(directory, files.adapter.path), "adapter");
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "1.2.3",
      revision: "revision",
      createdAt: "2026-08-11T00:00:00.000Z",
      files,
    }),
  );
  return directory;
}

function resource(path: string, content: string) {
  return {
    path,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
