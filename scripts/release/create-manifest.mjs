import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const manifestFileName = "release-manifest.json";
const checksumsFileName = "SHA256SUMS";
const releaseVariants = ["amd64", "arm64", "amd64-musl", "arm64-musl"];

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function releaseDate() {
  const rawEpoch = process.env.SOURCE_DATE_EPOCH ?? "0";
  if (!/^\d+$/.test(rawEpoch)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer.");
  }
  return new Date(Number(rawEpoch) * 1000).toISOString();
}

async function artifact(directory, name) {
  const filePath = resolve(directory, name);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Release entry is not a regular file: ${name}`);
  }
  return {
    name,
    sizeBytes: fileStat.size,
    sha256: await sha256(filePath),
  };
}

function expectedArtifactNames(version) {
  const platformArtifacts = releaseVariants.flatMap((variant) => {
    const backendName = `autoforge-backend-${version}-${variant}`;
    return [
      `${backendName}.docker.tar.zst`,
      `${backendName}.image.json`,
      `${backendName}.spdx.json`,
    ];
  });
  return [
    ...platformArtifacts,
    `autoforge-deploy-${version}.tar.gz`,
    `autoforge-deploy-${version}.spdx.json`,
    `autoforge-jenkins-dependency-publisher-${version}.hpi`,
    `autoforge-jenkins-dependency-publisher-${version}.spdx.json`,
    `autoforge-jenkins-execution-${version}.hpi`,
    `autoforge-jenkins-execution-${version}.spdx.json`,
    "CHANGELOG.md",
    "COMPATIBILITY.md",
    "LICENSE",
    "NOTICE",
    "release-signing-public-key.pem",
    "THIRD_PARTY_LICENSES.json",
  ];
}

function verifyArtifactSet(version, names) {
  const expected = expectedArtifactNames(version).sort();
  const actual = [...names].sort();
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Release artifact set is incomplete. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

export async function createReleaseMetadata(version, directory) {
  if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const outputDirectory = resolve(directory);
  const names = (await readdir(outputDirectory))
    .filter((name) => name !== manifestFileName && name !== checksumsFileName)
    .sort();
  if (names.length === 0) {
    throw new Error("Release directory contains no artifacts.");
  }
  verifyArtifactSet(version, names);

  const artifacts = await Promise.all(names.map((name) => artifact(outputDirectory, name)));
  const manifest = {
    schemaVersion: 1,
    product: "AutoForge",
    repository: "https://github.com/iskycc/auto-forge",
    version,
    generatedAt: releaseDate(),
    artifacts,
  };
  const manifestPath = resolve(outputDirectory, manifestFileName);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

  const checksumEntries = [...artifacts, await artifact(outputDirectory, manifestFileName)].sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const checksums = checksumEntries.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n");
  await writeFile(resolve(outputDirectory, checksumsFileName), `${checksums}\n`, { mode: 0o644 });
}

async function main() {
  const [version, directory] = process.argv.slice(2);
  if (!version || !directory) {
    throw new Error(`Usage: ${basename(process.argv[1])} VERSION RELEASE_DIRECTORY`);
  }
  await createReleaseMetadata(version.replace(/^v/, ""), directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
