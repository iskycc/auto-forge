import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractReleaseMetadata } from "./extract-release-metadata.mjs";

test("extracts metadata for historical and current manifests before validating signed assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoforge-metadata-schema-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "NOTICE"), "signed metadata");
    execFileSync("tar", [
      "-czf",
      join(root, "autoforge-release-metadata-1.2.3.tar.gz"),
      "-C",
      source,
      "NOTICE",
    ]);
    for (const schemaVersion of [2, 3, 4]) {
      await writeFile(join(root, "release-manifest.json"), JSON.stringify({ schemaVersion }));
      const destination = join(root, `schema-${schemaVersion}`);
      await extractReleaseMetadata(root, "1.2.3", destination);
      assert.equal(await readFile(join(destination, "NOTICE"), "utf8"), "signed metadata");
    }
    await writeFile(join(root, "release-manifest.json"), JSON.stringify({ schemaVersion: 1 }));
    await extractReleaseMetadata(root, "missing-legacy-archive", join(root, "legacy"));
    await writeFile(join(root, "release-manifest.json"), JSON.stringify({ schemaVersion: 5 }));
    await assert.rejects(
      extractReleaseMetadata(root, "1.2.3", join(root, "future")),
      /Unsupported/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
