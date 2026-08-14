import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createAgentResourceManifest } from "./create-agent-resource-manifest.mjs";

test("the internal Agent installer is offline and supports the declared distributions", async () => {
  const installer = await readFile(resolve("scripts/agent/install.sh"), "utf8");
  assert.match(installer, /ubuntu/);
  assert.match(installer, /opensuse-leap/);
  assert.match(installer, /opensuse-tumbleweed/);
  assert.match(installer, /systemctl/);
  assert.match(installer, /root \| autoforge-agent/);
  assert.match(installer, /installation_mode/);
  assert.match(installer, /cotest-testng-adapter\.jar/);
  assert.match(installer, /installed_adapter/);
  assert.match(installer, /^#!\/usr\/bin\/env bash/);
  assert.doesNotMatch(installer, /cgroup v2 is required/);
  assert.doesNotMatch(installer, /\b(?:apt|apt-get|zypper)\b/);
});

test("creates checksums for both embedded Agent architectures", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-agent-resources-"));
  try {
    await mkdir(resolve(directory, "linux-amd64"));
    await mkdir(resolve(directory, "linux-arm64"));
    await writeFile(resolve(directory, "linux-amd64/autoforge-agent"), "amd64-agent");
    await writeFile(resolve(directory, "linux-arm64/autoforge-agent"), "arm64-agent");
    await writeFile(resolve(directory, "install.sh"), "installer");
    await writeFile(resolve(directory, "cotest-testng-adapter.jar"), "adapter");
    await createAgentResourceManifest("1.2.3", "revision", "2026-08-11T00:00:00.000Z", directory);
    const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.files["linux-amd64"].size, 11);
    assert.equal(manifest.files["linux-arm64"].size, 11);
    assert.match(manifest.files.installer.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.files.adapter.sha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
