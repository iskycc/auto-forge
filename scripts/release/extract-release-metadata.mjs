import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releaseManifestSchemaVersion } from "./create-manifest.mjs";

export async function extractReleaseMetadata(directory, version, destination) {
  const manifest = JSON.parse(await readFile(join(directory, "release-manifest.json"), "utf8"));
  if (manifest.schemaVersion === 1) return;
  if (![2, 3, releaseManifestSchemaVersion].includes(manifest.schemaVersion))
    throw new Error(`Unsupported Release manifest schema: ${manifest.schemaVersion}`);
  await mkdir(destination, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(directory, `autoforge-release-metadata-${version}.tar.gz`),
    "-C",
    destination,
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await extractReleaseMetadata(process.argv[2], process.argv[3], process.argv[4]);
