import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publishes complete release assets without waiting for checks", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");

  assert.doesNotMatch(workflow, /^  quality:/m);
  assert.doesNotMatch(workflow, /^  offline-acceptance:/m);
  assert.doesNotMatch(workflow, /signed-release-candidate/);
  assert.match(workflow, /  adapter:\n[\s\S]*?    needs: prepare/);
  assert.match(workflow, /  backend:\n[\s\S]*?    needs: \[prepare, adapter\]/);
  assert.doesNotMatch(workflow, /^  toolchain:/m);
  assert.match(workflow, /  publish:\n[\s\S]*?    needs: \[prepare, backend\]/);
});

test("runs tagged source and published asset checks independently", async () => {
  const workflow = await readFile(".github/workflows/release-checks.yml", "utf8");

  assert.match(workflow, /^name: Release checks$/m);
  assert.match(workflow, /^  quality:/m);
  assert.match(workflow, /^  offline-acceptance:/m);
  assert.match(workflow, /  offline-acceptance:\n[\s\S]*?    needs: prepare/);
  assert.doesNotMatch(workflow, /  offline-acceptance:\n[\s\S]*?    needs: \[prepare, quality\]/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.tag_revision \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.checks_revision \}\}/);
  assert.match(workflow, /GITHUB_EVENT_NAME.*workflow_dispatch/);
  assert.match(workflow, /gh release download "\$\{CURRENT_TAG\}" --dir release/);
});

test("uses cached builds and parallel archive compression", async () => {
  const [workflow, buildScript] = await Promise.all([
    readFile(".github/workflows/release.yml", "utf8"),
    readFile("scripts/release/build-backend-image.sh", "utf8"),
  ]);

  assert.match(workflow, /AUTOFORGE_BUILDX_CACHE_FROM: type=gha/);
  assert.match(workflow, /AUTOFORGE_BUILDX_CACHE_TO: type=gha/);
  assert.match(buildScript, /zstd --threads=0 -10 -f/);
});
