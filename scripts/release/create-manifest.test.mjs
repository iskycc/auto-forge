import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createReleaseMetadata } from "./create-manifest.mjs";

test("creates a deterministic manifest and checksum list", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-release-"));
  const originalEpoch = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = "1786233600";
  try {
    for (const variant of ["amd64", "arm64", "amd64-musl", "arm64-musl"]) {
      const backendName = `autoforge-backend-1.2.3-${variant}`;
      await writeFile(resolve(directory, `${backendName}.docker.tar.zst`), `image-${variant}`);
      await writeFile(resolve(directory, `${backendName}.image.json`), "{}");
      await writeFile(resolve(directory, `${backendName}.spdx.json`), "{}");
    }
    await writeFile(resolve(directory, "autoforge-deploy-1.2.3.tar.gz"), "compose");
    await writeFile(resolve(directory, "autoforge-deploy-1.2.3.spdx.json"), "{}");
    for (const fileName of [
      "CHANGELOG.md",
      "COMPATIBILITY.md",
      "LICENSE",
      "NOTICE",
      "release-signing-public-key.pem",
      "THIRD_PARTY_LICENSES.json",
    ]) {
      await writeFile(resolve(directory, fileName), fileName);
    }
    await createReleaseMetadata("1.2.3", directory);

    const manifest = JSON.parse(
      await readFile(resolve(directory, "release-manifest.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.artifacts.length, 20);

    const checksums = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
    assert.doesNotMatch(checksums, /autoforge-agent/);
    assert.doesNotMatch(checksums, /runner-toolchain/);
    assert.match(checksums, /autoforge-deploy-1\.2\.3\.tar\.gz/);
    assert.match(checksums, /release-manifest\.json/);
    assert.match(checksums, /release-signing-public-key\.pem/);
  } finally {
    if (originalEpoch === undefined) {
      delete process.env.SOURCE_DATE_EPOCH;
    } else {
      process.env.SOURCE_DATE_EPOCH = originalEpoch;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
