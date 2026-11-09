import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = ".acceptance-build/manifest.json";
const outputRoots = {
  web: ["apps/web/.next", "apps/web/dist-server"],
  threads: ["apps/web/dist-server"],
  worker: ["apps/worker/dist"],
  agents: ["resources/agents"],
  resources: ["resources/jenkins", "resources/log-archive-viewer"],
  tools: [".acceptance-build/dependencies"],
};
const requiredFiles = [
  "apps/web/.next/BUILD_ID",
  "apps/web/.next/server/app-paths-manifest.json",
  "apps/web/dist-server/server/index.js",
  "apps/web/dist-server/server/work-thread.js",
  "apps/worker/dist/worker.mjs",
  "resources/agents/manifest.json",
  "resources/jenkins/manifest.json",
  "resources/log-archive-viewer/manifest.json",
];
const runtime = () => ({
  node: process.versions.node,
  abi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
});
const revision = (root) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const belongsTo = (path, roots) => roots.some((root) => path.startsWith(`${root}/`));
const excluded = (path) =>
  /^apps\/web\/\.next\/(cache|dev|diagnostics)(\/|$)/.test(path) || path === "apps/web/.next/trace";

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function sourceDigest(root) {
  const hash = createHash("sha256");
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const path of paths) hash.update(`${path}\0${await sha256(join(root, path))}\0`);
  return hash.digest("hex");
}

async function collectOutputs(root, path) {
  if (excluded(path)) return [];
  const absolutePath = join(root, path);
  const stat = await lstat(absolutePath);
  if (stat.isDirectory()) {
    const entries = [];
    for (const name of (await readdir(absolutePath)).sort())
      entries.push(...(await collectOutputs(root, `${path}/${name}`)));
    return entries;
  }
  // Next's external modules point to the locked pnpm installation, restored independently.
  if (stat.isSymbolicLink()) return [{ path, link: await readlink(absolutePath) }];
  if (!stat.isFile()) throw new Error(`Unsupported acceptance build output: ${path}`);
  return [{ path, sha256: await sha256(absolutePath), mode: stat.mode & 0o777 }];
}

export async function sealAcceptanceBuild(root) {
  const files = [];
  for (const path of [...new Set(Object.values(outputRoots).flat())]) {
    if (path === ".acceptance-build/dependencies" && !existsSync(join(root, path))) continue;
    files.push(...(await collectOutputs(root, path)));
  }
  const manifest = {
    schemaVersion: 1,
    revision: revision(root),
    sourceDigest: await sourceDigest(root),
    runtime: runtime(),
    files,
  };
  await mkdir(join(root, ".acceptance-build"), { recursive: true });
  await writeFile(join(root, manifestPath), `${JSON.stringify(manifest)}\n`);
  await verifyAcceptanceBuild(root, "all");
}

export async function verifyAcceptanceBuild(root, scope) {
  const roots = scope === "all" ? Object.values(outputRoots).flat() : outputRoots[scope];
  if (!roots) throw new Error(`Unknown acceptance build scope: ${scope}`);
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.revision !== revision(root))
    throw new Error("Acceptance build revision does not match this checkout.");
  if (!Object.entries(runtime()).every(([key, value]) => manifest.runtime?.[key] === value))
    throw new Error("Acceptance build runtime does not match this Node/platform/architecture.");
  if (manifest.sourceDigest !== (await sourceDigest(root)))
    throw new Error("Acceptance build source has changed; rebuild the current source.");
  if (!Array.isArray(manifest.files)) throw new Error("Acceptance build file manifest is missing.");
  for (const path of requiredFiles.filter((path) => belongsTo(path, roots))) {
    if (!manifest.files.some((entry) => entry.path === path && entry.sha256))
      throw new Error(`Acceptance build is missing ${path}`);
  }
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      entry.path.split("/").some((part) => part === ".." || part === "") ||
      !belongsTo(entry.path, Object.values(outputRoots).flat())
    )
      throw new Error("Invalid acceptance build output path.");
    if (!belongsTo(entry.path, roots)) continue;
    const path = join(root, entry.path);
    const stat = await lstat(path);
    const valid =
      entry.link !== undefined
        ? stat.isSymbolicLink() && entry.link === (await readlink(path))
        : stat.isFile() &&
          entry.mode === (stat.mode & 0o777) &&
          entry.sha256 === (await sha256(path));
    if (!valid) throw new Error(`Acceptance build verification failed: ${entry.path}`);
  }
}

export async function packAcceptanceBuild(root) {
  await verifyAcceptanceBuild(root, "all");
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  const listPath = join(root, ".acceptance-build/files.txt");
  await writeFile(
    listPath,
    [...manifest.files.map((entry) => entry.path), manifestPath].join("\0") + "\0",
  );
  const archive = join(root, ".acceptance-build/runtime.tar.gz");
  execFileSync(
    "tar",
    [
      "--create",
      "--use-compress-program=gzip -1",
      "--file",
      archive,
      "--null",
      "--no-recursion",
      "--files-from",
      listPath,
    ],
    { cwd: root, stdio: "inherit" },
  );
  return archive;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const [command, scope = "all"] = process.argv.slice(2);
  if (command === "seal") {
    await sealAcceptanceBuild(root);
    await packAcceptanceBuild(root);
  } else if (command === "verify") await verifyAcceptanceBuild(root, scope);
  else throw new Error("Usage: acceptance-build.mjs seal|verify [scope]");
}
