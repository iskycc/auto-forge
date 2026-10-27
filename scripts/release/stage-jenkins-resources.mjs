import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jenkinsSourceDigest } from "./jenkins-source-digest.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const version = process.argv[2];
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("Usage: stage-jenkins-resources.mjs VERSION");
const output = resolve(root, "resources/jenkins");
await mkdir(output, { recursive: true });
const plugins = [];
for (const kind of ["execution", "dependency-publisher"]) {
  const name = `autoforge-${kind}`;
  const source = resolve(root, `integrations/jenkins/${name}/target/${name}.hpi`);
  const content = await readFile(source);
  const metadata = execFileSync("unzip", ["-p", source, "META-INF/MANIFEST.MF"], {
    encoding: "utf8",
  }).replace(/\r\n /g, "");
  if (
    !metadata
      .split(/\r?\n/)
      .some(
        (line) =>
          line === `Plugin-Version: ${version}` || line.startsWith(`Plugin-Version: ${version} `),
      )
  )
    throw new Error(`Plugin version does not match ${version}: ${source}`);
  if (content.length === 0) throw new Error(`Empty Jenkins plugin: ${source}`);
  const fileName = `autoforge-jenkins-${kind}-${version}.hpi`;
  await copyFile(source, resolve(output, fileName));
  plugins.push({
    kind,
    fileName,
    sizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
const expectedFiles = new Set(plugins.map((plugin) => plugin.fileName));
for (const name of await readdir(output)) {
  if (
    /^autoforge-jenkins-(?:execution|dependency-publisher)-[0-9A-Za-z.-]+\.hpi$/.test(name) &&
    !expectedFiles.has(name)
  )
    await unlink(resolve(output, name));
}
await writeFile(
  resolve(output, "manifest.json"),
  JSON.stringify(
    { schemaVersion: 1, version, sourceDigest: await jenkinsSourceDigest(root), plugins },
    null,
    2,
  ) + "\n",
);
