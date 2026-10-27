import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jenkinsSourceDigest } from "./jenkins-source-digest.mjs";
import { verifyJenkinsResources } from "./verify-jenkins-resources.mjs";
import { createHash } from "node:crypto";

test("rebuilds for Jenkins source changes while ignoring Maven output", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoforge-jenkins-source-"));
  try {
    const source = join(root, "integrations/jenkins/module/src");
    const target = join(root, "integrations/jenkins/module/target");
    await mkdir(source, { recursive: true });
    await mkdir(target);
    await writeFile(join(source, "Step.java"), "source-v1");
    const initial = await jenkinsSourceDigest(root);
    await writeFile(join(target, "plugin.hpi"), "generated-build-output");
    assert.equal(await jenkinsSourceDigest(root), initial);
    await writeFile(join(source, "Step.java"), "source-v2");
    assert.notEqual(await jenkinsSourceDigest(root), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires exactly the two versioned, checksum-verified embedded Jenkins plugins", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoforge-jenkins-package-"));
  const content = Buffer.from("packaged-plugin");
  try {
    const plugins = [];
    for (const kind of ["execution", "dependency-publisher"]) {
      const fileName = `autoforge-jenkins-${kind}-1.2.3.hpi`;
      await writeFile(join(root, fileName), content);
      plugins.push({
        kind,
        fileName,
        sizeBytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, version: "1.2.3", plugins }),
    );
    assert.equal((await verifyJenkinsResources(root, "1.2.3")).version, "1.2.3");
    await assert.rejects(verifyJenkinsResources(root, "1.2.4"), /version/);
    const path = join(root, plugins[0].fileName);
    const original = await readFile(path);
    await writeFile(path, "damaged");
    await assert.rejects(verifyJenkinsResources(root), /checksum/);
    await writeFile(path, original);
    await writeFile(join(root, "obsolete.hpi"), "old-version");
    await assert.rejects(verifyJenkinsResources(root), /Unexpected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
