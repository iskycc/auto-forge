import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, matchesGlob, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function selectReleaseAssets(assets, patterns) {
  const selected = assets.filter((asset) => {
    if (
      !asset ||
      typeof asset !== "object" ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      typeof asset.name !== "string" ||
      !asset.name ||
      asset.name === "." ||
      asset.name === ".." ||
      basename(asset.name) !== asset.name ||
      asset.name.includes("\\") ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      asset.state !== "uploaded"
    )
      throw new Error("Release contains an invalid or incomplete asset.");
    return patterns.length === 0 || patterns.some((pattern) => matchesGlob(asset.name, pattern));
  });
  if (selected.length === 0) throw new Error("No matching published release assets.");
  if (new Set(selected.map((asset) => asset.name)).size !== selected.length)
    throw new Error("Release contains duplicate asset names.");
  return selected;
}

function githubJson(args) {
  return JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", timeout: 30_000 }));
}

export function listReleaseAssets(tag, readGithub = githubJson) {
  if (!/^v\d+\.\d+\.\d+(?:[.-][\dA-Za-z.-]+)?$/u.test(tag))
    throw new Error(`Invalid release tag: ${tag}`);
  const release = readGithub([`repos/{owner}/{repo}/releases/tags/${tag}`]);
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.draft)
    throw new Error(`Release ${tag} is not published.`);
  // The tag lookup can briefly return an empty embedded assets array after
  // publishing. The independently paginated asset collection remains authoritative.
  const pages = readGithub([
    `repos/{owner}/{repo}/releases/${release.id}/assets?per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error("GitHub returned an invalid release asset collection.");
  return pages.flat();
}

export function downloadReleaseAsset(asset, directory, execute = execFileSync) {
  const destination = join(directory, asset.name);
  const temporary = `${destination}.partial`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    try {
      execute(
        "gh",
        [
          "api",
          `repos/{owner}/{repo}/releases/assets/${asset.id}`,
          "-H",
          "Accept: application/octet-stream",
        ],
        { stdio: ["ignore", descriptor, "inherit"], timeout: 180_000 },
      );
    } finally {
      closeSync(descriptor);
    }
    if (statSync(temporary).size !== asset.size)
      throw new Error(`Downloaded size does not match release asset ${asset.name}.`);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, directory, ...patterns] = process.argv.slice(2);
  if (!tag || !directory)
    throw new Error("usage: download-assets.mjs TAG DIRECTORY [ASSET_PATTERN ...]");
  const assets = selectReleaseAssets(listReleaseAssets(tag), patterns);
  mkdirSync(directory, { recursive: true });
  for (const asset of assets) {
    console.log(`Downloading ${asset.name} (${asset.size} bytes)`);
    downloadReleaseAsset(asset, directory);
  }
}
