import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logViewerSourceDigest, verifyLogViewerResources } from "./log-viewer-resources.mjs";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceDigest = await logViewerSourceDigest(root);
let manifest;
try {
  manifest = await verifyLogViewerResources(resolve(root, "resources/log-archive-viewer"));
} catch (cause) {
  process.stderr.write(
    `Preparing offline log viewer: ${cause instanceof Error ? cause.message : "invalid resources"}\n`,
  );
}
if (manifest?.sourceDigest !== sourceDigest)
  execFileSync("bash", ["scripts/release/build-log-archive-viewer-resources.sh"], {
    cwd: root,
    stdio: "inherit",
  });
