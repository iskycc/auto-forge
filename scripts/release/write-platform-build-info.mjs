import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function platformBuildInfo(version, revision, createdAt) {
  if (version === "dev") return { version, kind: "development" };
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
    throw new Error("Platform build version must be a semantic release version or dev.");
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Platform release build requires its full Git commit.");
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new Error("Platform release build requires a valid creation timestamp.");
  return { version, kind: "release", revision, createdAt: new Date(createdAt).toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, revision, createdAt] = process.argv.slice(2);
  const metadata = platformBuildInfo(version, revision, createdAt);
  await writeFile(
    new URL("../../apps/web/src/lib/platform-build-info.json", import.meta.url),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}
