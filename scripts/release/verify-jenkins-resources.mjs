import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyJenkinsResources(directory, expectedVersion) {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    !Array.isArray(manifest.plugins) ||
    manifest.plugins.length !== 2 ||
    (expectedVersion && manifest.version !== expectedVersion)
  )
    throw new Error("Invalid embedded Jenkins manifest/version");
  for (const kind of ["execution", "dependency-publisher"]) {
    const plugin = manifest.plugins.find((plugin) => plugin.kind === kind);
    if (!plugin || plugin.fileName !== `autoforge-jenkins-${kind}-${manifest.version}.hpi`)
      throw new Error(`Missing embedded Jenkins plugin: ${kind}`);
    const content = await readFile(resolve(directory, plugin.fileName));
    if (
      !content.length ||
      content.length !== plugin.sizeBytes ||
      createHash("sha256").update(content).digest("hex") !== plugin.sha256
    )
      throw new Error(`Invalid embedded Jenkins plugin checksum: ${kind}`);
  }
  const expected = ["manifest.json", ...manifest.plugins.map((plugin) => plugin.fileName)].sort();
  const files = (await readdir(directory)).sort();
  if (JSON.stringify(files) !== JSON.stringify(expected))
    throw new Error("Unexpected embedded Jenkins resources");
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyJenkinsResources(process.argv[2], process.argv[3]);
