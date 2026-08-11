import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const resourceFiles = [
  ["linux-amd64", "linux-amd64/autoforge-agent"],
  ["linux-arm64", "linux-arm64/autoforge-agent"],
  ["installer", "install.sh"],
];

export async function createAgentResourceManifest(version, revision, createdAt, resourceDirectory) {
  const files = {};
  for (const [key, relativePath] of resourceFiles) {
    const content = await readFile(resolve(resourceDirectory, relativePath));
    files[key] = {
      path: relativePath,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  await writeFile(
    resolve(resourceDirectory, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version,
        revision,
        createdAt,
        files,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
}

async function main() {
  const [version, revision, createdAt, resourceDirectory] = process.argv.slice(2);
  if (!version || !revision || !createdAt || !resourceDirectory) {
    throw new Error(
      `usage: ${basename(process.argv[1])} VERSION REVISION CREATED_AT RESOURCE_DIRECTORY`,
    );
  }
  await createAgentResourceManifest(version, revision, createdAt, resourceDirectory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
