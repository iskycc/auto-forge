import { logViewerSourceDigest } from "./log-viewer-resources.mjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [version, directory] = process.argv.slice(2);
if (!version || !directory) throw new Error("Expected version and resource directory.");
const files = [];
for (const path of ["viewer-linux-amd64", "viewer-linux-arm64", "viewer-windows-amd64.exe"]) {
  const content = await readFile(join(directory, path));
  if (
    path.endsWith(".exe")
      ? content.toString("ascii", 0, 2) !== "MZ"
      : content.toString("hex", 0, 4) !== "7f454c46"
  )
    throw new Error(`Invalid executable ${path}`);
  files.push({
    path,
    sizeBytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
}
const licenseBytes = await readFile(join(directory, "viewer-licenses.txt"));
const license = {
  path: "viewer-licenses.txt",
  sizeBytes: licenseBytes.length,
  sha256: createHash("sha256").update(licenseBytes).digest("hex"),
};
const sourceDigest = await logViewerSourceDigest(
  resolve(fileURLToPath(new URL("../..", import.meta.url))),
);
await writeFile(
  join(directory, "manifest.json"),
  JSON.stringify({ schemaVersion: 1, version, sourceDigest, files, license }, null, 2) + "\n",
);
