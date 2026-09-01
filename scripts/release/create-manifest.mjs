import { createHash } from "node:crypto";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const manifestFileName = "release-manifest.json";
const checksumsFileName = "SHA256SUMS";
const releaseVariants = ["amd64", "arm64", "amd64-musl", "arm64-musl"];
export const releaseManifestSchemaVersion = 2;

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

export function expectedArtifactNames(version) {
  const platformArtifacts = releaseVariants.map(
    (variant) => `autoforge-backend-${version}-${variant}.docker.tar`,
  );
  return [
    ...platformArtifacts,
    `autoforge-deploy-${version}.tar.gz`,
    `autoforge-jenkins-dependency-publisher-${version}.hpi`,
    `autoforge-jenkins-execution-${version}.hpi`,
    `autoforge-release-metadata-${version}.tar.gz`,
    "release-signing-public-key.pem",
  ];
}

export function expectedImageMetadataInputNames(version) {
  return releaseVariants.map((variant) => `autoforge-backend-${version}-${variant}.image.json`);
}

export function expectedMetadataBundleFileNames(version) {
  return [
    "CHANGELOG.md",
    "COMPATIBILITY.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_LICENSES.json",
    ...releaseVariants.map((variant) => `sbom/autoforge-backend-${version}-${variant}.spdx.json`),
    `sbom/autoforge-deploy-${version}.spdx.json`,
    `sbom/autoforge-jenkins-dependency-publisher-${version}.spdx.json`,
    `sbom/autoforge-jenkins-execution-${version}.spdx.json`,
  ];
}

function verifyReleaseWorkingSet(version, names) {
  const expected = [
    ...expectedArtifactNames(version),
    ...expectedImageMetadataInputNames(version),
  ].sort();
  const actual = [...names].sort();
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Release artifact set is incomplete. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

function validateBackendImageMetadata(metadata, version, variant, sourceName) {
  const expectedArchitecture = variant.startsWith("amd64") ? "amd64" : "arm64";
  const expectedReference = `autoforge/backend:${version}-${variant}`;
  if (
    metadata?.schemaVersion !== 1 ||
    metadata.product !== "AutoForge Backend" ||
    metadata.version !== version ||
    metadata.variant !== variant ||
    metadata.imageReference !== expectedReference ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.immutableImageId ?? "") ||
    metadata.architecture !== expectedArchitecture ||
    metadata.operatingSystem !== "linux" ||
    typeof metadata.createdAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    !metadata.labels ||
    typeof metadata.labels !== "object" ||
    Array.isArray(metadata.labels) ||
    Object.values(metadata.labels).some((value) => typeof value !== "string")
  ) {
    throw new Error(`Invalid backend image metadata: ${sourceName}`);
  }
  return {
    version,
    variant,
    imageReference: metadata.imageReference,
    immutableImageId: metadata.immutableImageId,
    architecture: metadata.architecture,
    operatingSystem: metadata.operatingSystem,
    createdAt: metadata.createdAt,
    labels: Object.fromEntries(
      Object.entries(metadata.labels).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

async function readBackendImageMetadata(version, directory) {
  return Promise.all(
    releaseVariants.map(async (variant) => {
      const sourceName = `autoforge-backend-${version}-${variant}.image.json`;
      const metadata = JSON.parse(await readFile(resolve(directory, sourceName), "utf8"));
      return validateBackendImageMetadata(metadata, version, variant, sourceName);
    }),
  );
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
  verifyReleaseWorkingSet(version, names);

  const backendImages = await readBackendImageMetadata(version, outputDirectory);
  const artifactNames = expectedArtifactNames(version).sort();
  const artifacts = await Promise.all(artifactNames.map((name) => artifact(outputDirectory, name)));
  const manifest = {
    schemaVersion: releaseManifestSchemaVersion,
    product: "AutoForge",
    repository: "https://github.com/iskycc/auto-forge",
    version,
    generatedAt: releaseDate(),
    backendImages,
    artifacts,
  };
  const manifestPath = resolve(outputDirectory, manifestFileName);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

  const checksumEntries = [...artifacts, await artifact(outputDirectory, manifestFileName)].sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const checksums = checksumEntries.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n");
  await writeFile(resolve(outputDirectory, checksumsFileName), `${checksums}\n`, { mode: 0o644 });
  await Promise.all(
    expectedImageMetadataInputNames(version).map((name) => unlink(resolve(outputDirectory, name))),
  );
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
