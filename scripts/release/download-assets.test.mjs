import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  selectReleaseAssets,
} from "./download-assets.mjs";

const asset = { id: 10, name: "image.docker.tar", size: 3, state: "uploaded" };

test("reads paginated assets when a published tag lookup has an empty embedded list", () => {
  const requests = [];
  const assets = listReleaseAssets("v1.17.24", (args) => {
    requests.push(args);
    return requests.length === 1 ? { id: 42, draft: false, assets: [] } : [[asset], []];
  });
  assert.deepEqual(assets, [asset]);
  assert.deepEqual(requests[1], [
    "repos/{owner}/{repo}/releases/42/assets?per_page=100",
    "--paginate",
    "--slurp",
  ]);
});

test("filters the union of asset patterns and rejects empty or unsafe downloads", () => {
  assert.deepEqual(selectReleaseAssets([asset], ["*.docker.tar", "*.image.json"]), [asset]);
  assert.throws(() => selectReleaseAssets([asset], ["*.hpi"]), /No matching/u);
  assert.throws(() => selectReleaseAssets([{ ...asset, name: "../escape" }], []), /invalid/u);
  assert.throws(() => selectReleaseAssets([{ ...asset, state: "new" }], []), /incomplete/u);
  assert.throws(() => selectReleaseAssets([asset, asset], []), /duplicate/u);
  assert.throws(() => listReleaseAssets("main"), /Invalid release tag/u);
  assert.throws(
    () => listReleaseAssets("v1.17.24", () => ({ id: 42, draft: true })),
    /not published/u,
  );
});

test("checks downloaded size and removes partial output after failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "autoforge-release-download-"));
  try {
    const writeDownload = (contents) => (_command, _args, options) =>
      writeSync(options.stdio[1], contents);
    assert.throws(() => downloadReleaseAsset(asset, directory, writeDownload("x")), /size/u);
    assert.deepEqual(readdirSync(directory), []);
    assert.throws(
      () =>
        downloadReleaseAsset(asset, directory, () => {
          throw new Error("network interrupted");
        }),
      /network interrupted/u,
    );
    assert.deepEqual(readdirSync(directory), []);
    downloadReleaseAsset(asset, directory, writeDownload("tar"));
    assert.equal(readFileSync(join(directory, asset.name), "utf8"), "tar");
    assert.deepEqual(readdirSync(directory), [asset.name]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
