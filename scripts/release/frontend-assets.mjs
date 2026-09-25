import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REQUIRED_COMPONENT_STYLES = [
  "btn",
  "modal",
  "table",
  "collapse",
  "tabs",
  "menu",
  "popover",
  "progress",
  "pagination",
  "alert",
  "empty",
  "spin",
  "checkbox",
  "select",
  "picker",
  "tag",
  "segmented",
  "result",
  "statistic",
  "tooltip",
  "input-number",
  "select-auto-complete",
  "splitter",
  "image",
  "upload",
  "avatar",
  "timeline",
  "steps",
];

async function listAssets(directory, prefix = "") {
  const paths = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...(await listAssets(directory, path)));
    else if (entry.isFile() && !entry.name.endsWith(".map")) paths.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`Frontend asset cannot be a symlink: ${path}`);
  }
  return paths.sort();
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Verify the complete compiled frontend, including lazy chunks, before exporting the image. */
export async function verifyAndRecordFrontendAssets(sourceStatic, packagedStatic, manifestPath) {
  const paths = await listAssets(sourceStatic);
  if (!paths.some((path) => path.endsWith(".js")) || !paths.some((path) => path.endsWith(".css")))
    throw new Error("Frontend build must contain local JavaScript and CSS assets.");
  const missingStyles = new Set(REQUIRED_COMPONENT_STYLES);
  const assets = [];
  for (const path of paths) {
    const expected = await readFile(join(sourceStatic, path));
    let actual;
    try {
      actual = await readFile(join(packagedStatic, path));
    } catch (cause) {
      throw new Error(`Offline runtime is missing frontend asset: ${path}`, { cause });
    }
    const sha256 = digest(expected);
    if (digest(actual) !== sha256)
      throw new Error(`Offline frontend asset differs from the production build: ${path}`);
    if (path.endsWith(".css")) {
      const css = actual.toString("utf8");
      if (/(?:url\(\s*["']?|@import\s*["'])(?:https?:)?\/\//iu.test(css))
        throw new Error(`Offline stylesheet references a remote resource: ${path}`);
      for (const component of missingStyles) {
        if (css.includes(`.ant-${component}`)) missingStyles.delete(component);
      }
    }
    assets.push({ path: `/_next/static/${path}`, sizeBytes: actual.length, sha256 });
  }
  if (missingStyles.size)
    throw new Error(
      `Ant Design component CSS is missing from the offline frontend build: ${[...missingStyles].join(", ")}.`,
    );
  const manifest = { schemaVersion: 1, componentLibrary: "antd", assets };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
