import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createReleaseMetadata, expectedArtifactNames } from "./create-manifest.mjs";

test("creates a deterministic manifest and checksum list", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-release-"));
  const originalEpoch = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = "1786233600";
  try {
    for (const variant of ["amd64", "arm64"]) {
      const backendName = `autoforge-backend-1.2.3-${variant}`;
      await writeFile(resolve(directory, `${backendName}.docker.tar`), `image-${variant}`);
      await writeFile(
        resolve(directory, `${backendName}.image.json`),
        JSON.stringify({
          schemaVersion: 1,
          product: "AutoForge Backend",
          version: "1.2.3",
          variant,
          imageReference: `autoforge/backend:1.2.3-${variant}`,
          immutableImageId: `sha256:${variant.startsWith("amd64") ? "a" : "b"}${"0".repeat(63)}`,
          architecture: variant.startsWith("amd64") ? "amd64" : "arm64",
          operatingSystem: "linux",
          createdAt: "2026-08-09T00:00:00.000Z",
          labels: { "org.opencontainers.image.version": "1.2.3" },
        }),
      );
    }
    await writeFile(resolve(directory, "autoforge-deploy-1.2.3.tar.gz"), "compose");
    for (const plugin of ["dependency-publisher", "execution"]) {
      await writeFile(resolve(directory, `autoforge-jenkins-${plugin}-1.2.3.hpi`), plugin);
    }
    await writeFile(resolve(directory, "autoforge-release-metadata-1.2.3.tar.gz"), "metadata");
    await writeFile(resolve(directory, "release-signing-public-key.pem"), "public-key");
    await createReleaseMetadata("1.2.3", directory);

    const manifest = JSON.parse(
      await readFile(resolve(directory, "release-manifest.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.version, "1.2.3");
    assert.deepEqual(
      manifest.backendImages.map((image) => [image.variant, image.version, image.architecture]),
      [
        ["amd64", "1.2.3", "amd64"],
        ["arm64", "1.2.3", "arm64"],
      ],
    );
    assert.deepEqual(
      manifest.artifacts.map((artifact) => artifact.name).sort(),
      expectedArtifactNames("1.2.3").sort(),
    );

    const checksums = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
    assert.doesNotMatch(checksums, /autoforge-agent/);
    assert.doesNotMatch(checksums, /runner-toolchain/);
    assert.match(checksums, /autoforge-deploy-1\.2\.3\.tar\.gz/);
    assert.match(checksums, /autoforge-jenkins-execution-1\.2\.3\.hpi/);
    assert.match(checksums, /autoforge-jenkins-dependency-publisher-1\.2\.3\.hpi/);
    assert.match(checksums, /autoforge-release-metadata-1\.2\.3\.tar\.gz/);
    assert.match(checksums, /release-manifest\.json/);
    assert.match(checksums, /release-signing-public-key\.pem/);
    assert.doesNotMatch(checksums, /\.image\.json|\.spdx\.json|NOTICE/);
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith(".image.json")),
      [],
    );
  } finally {
    if (originalEpoch === undefined) {
      delete process.env.SOURCE_DATE_EPOCH;
    } else {
      process.env.SOURCE_DATE_EPOCH = originalEpoch;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
