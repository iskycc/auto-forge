import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
export async function logViewerSourceDigest(root) {
  const hash = createHash("sha256");
  async function walk(relative) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (!/\/assets\/(viewer\.(js|css)(\.LEGAL\.txt)?|licenses\.txt)$/.test(path)) {
        hash.update(path).update(await readFile(join(root, path)));
      }
    }
  }
  await walk("apps/log-archive-viewer");
  await walk("apps/web/src/archive-viewer");
  for (const path of [
    "LICENSE",
    "docs/licenses/ant-design-icons.txt",
    "pnpm-lock.yaml",
    "apps/web/src/lib/ant-design-theme.ts",
    "apps/web/src/lib/safe-ansi.ts",
    "apps/web/src/lib/log-levels.ts",
    "apps/web/src/lib/log-presentation.ts",
    "apps/web/src/components/ui/use-reduced-motion.ts",
    "apps/web/src/components/ui/semantic-status-tag.tsx",
    "apps/web/server/build-log-archive-ui.mjs",
    "scripts/release/build-log-archive-viewer-resources.sh",
    "scripts/release/create-log-viewer-manifest.mjs",
    "scripts/release/log-viewer-resources.mjs",
  ]) {
    hash.update(path).update(await readFile(join(root, path)));
  }
  return hash.digest("hex");
}
export async function verifyLogViewerResources(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.files?.length !== 3 || !manifest.license)
    throw new Error("Offline viewer resource manifest is invalid.");
  if (
    new Set(manifest.files.map((file) => file.path)).size !== 3 ||
    manifest.license.path !== "viewer-licenses.txt"
  )
    throw new Error("Offline viewer platform set or licenses are incomplete.");
  for (const file of [...manifest.files, manifest.license]) {
    if (!/^viewer-(linux-(amd64|arm64)|windows-amd64\.exe|licenses\.txt)$/.test(file.path))
      throw new Error("Offline viewer resource path is invalid.");
    const path = join(directory, file.path);
    const metadata = await stat(path);
    if (metadata.size !== file.sizeBytes || metadata.size > 64 * 1024 * 1024)
      throw new Error("Offline viewer resource size is invalid.");
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== file.sha256
    )
      throw new Error("Offline viewer resource checksum is invalid.");
  }
  return manifest;
}
