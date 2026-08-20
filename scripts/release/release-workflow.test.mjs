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

test("partitions tagged and published checks without polling inside a test job", async () => {
  const [taggedChecks, publishedAcceptance] = await Promise.all([
    readFile(".github/workflows/release-checks.yml", "utf8"),
    readFile(".github/workflows/release-acceptance.yml", "utf8"),
  ]);

  assert.match(taggedChecks, /^name: Release checks$/m);
  assert.match(taggedChecks, /^  quality:/m);
  assert.match(taggedChecks, /^  offline-quality:/m);
  assert.match(taggedChecks, /bash scripts\/quality\/test-full\.sh browser-governance/);
  assert.match(taggedChecks, /bash scripts\/quality\/test-offline\.sh "\$\{\{ matrix\.phase \}\}"/);
  assert.doesNotMatch(taggedChecks, /^  offline-acceptance:/m);
  assert.doesNotMatch(taggedChecks, /pnpm test:full\s*$/m);
  assert.doesNotMatch(taggedChecks, /pnpm test:offline\s*$/m);

  assert.match(publishedAcceptance, /^name: Published Release acceptance$/m);
  assert.match(publishedAcceptance, /^  workflow_run:/m);
  assert.match(publishedAcceptance, /workflows: \[Release\]/);
  assert.match(publishedAcceptance, /^  asset-integrity:/m);
  assert.match(publishedAcceptance, /^  acceptance:/m);
  assert.match(publishedAcceptance, /needs: \[prepare, asset-integrity\]/);
  assert.match(publishedAcceptance, /phase: business-governance/);
  assert.match(publishedAcceptance, /phase: upgrade-rollback/);
  assert.doesNotMatch(publishedAcceptance, /sleep "\$\{wait_interval_seconds\}"/);
  assert.match(publishedAcceptance, /ref: \$\{\{ needs\.prepare\.outputs\.checks_revision \}\}/);
  assert.match(publishedAcceptance, /GITHUB_EVENT_NAME.*workflow_dispatch/);
});

test("keeps long-running CI acceptance paths partitioned", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(workflow, /scenario: assets\n\s+specs: .*case-suite-lifecycle.*jar-import/);
  assert.match(workflow, /scenario: execution\n\s+specs: .*execution-recovery.*single-case-run/);
  assert.match(workflow, /scenario: identity\n\s+specs: .*identity-rbac.*all-rounds/);
  assert.match(workflow, /scenario: operations\n\s+specs: .*platform-operations.*ui-layout/);
  assert.doesNotMatch(workflow, /scenario:\n\s+- all-rounds/);
  assert.match(workflow, /test-full-business-recovery\.sh contracts/);
  assert.match(workflow, /test-full-business-recovery\.sh browser-governance/);
  assert.match(workflow, /test-full-business-recovery\.sh real-agent/);
  assert.match(workflow, /test-offline\.sh assets/);
  assert.match(workflow, /test-offline\.sh governance/);
  assert.doesNotMatch(workflow, /command: pnpm test:full-business-recovery\s*$/m);
  assert.doesNotMatch(workflow, /command: pnpm test:offline\s*$/m);
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
