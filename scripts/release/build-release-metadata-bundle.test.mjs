import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { expectedMetadataBundleFileNames } from "./create-manifest.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const version = "1.2.3";
const sbomNames = expectedMetadataBundleFileNames(version)
  .filter((name) => name.startsWith("sbom/"))
  .map((name) => name.slice("sbom/".length));

test("builds one deterministic legal and SBOM metadata archive", async () => {
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "autoforge-release-metadata-output-"));
  const extractedDirectory = await mkdtemp(
    resolve(tmpdir(), "autoforge-release-metadata-extract-"),
  );
  try {
    await writeSbomFixtures(outputDirectory);
    await buildMetadataBundle(outputDirectory);
    const archivePath = resolve(outputDirectory, `autoforge-release-metadata-${version}.tar.gz`);
    const firstArchive = await readFile(archivePath);

    assert.deepEqual((await readdir(outputDirectory)).sort(), [
      `autoforge-release-metadata-${version}.tar.gz`,
    ]);
    await execute("tar", ["-xzf", archivePath, "-C", extractedDirectory]);
    const packageDirectory = resolve(extractedDirectory, `autoforge-release-metadata-${version}`);
    for (const relativePath of expectedMetadataBundleFileNames(version)) {
      assert.ok((await readFile(resolve(packageDirectory, relativePath))).byteLength > 0);
    }

    await writeSbomFixtures(outputDirectory);
    await buildMetadataBundle(outputDirectory);
    assert.deepEqual(await readFile(archivePath), firstArchive);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await rm(extractedDirectory, { recursive: true, force: true });
  }
});

async function writeSbomFixtures(outputDirectory) {
  for (const name of sbomNames) {
    await writeFile(
      resolve(outputDirectory, name),
      `${JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [{ name: "fixture" }] })}\n`,
    );
  }
}

async function buildMetadataBundle(outputDirectory) {
  await execute(
    "bash",
    ["scripts/release/build-release-metadata-bundle.sh", version, outputDirectory],
    {
      cwd: repositoryRoot,
      env: { ...process.env, SOURCE_DATE_EPOCH: "1786233600" },
    },
  );
}
