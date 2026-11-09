import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CI shares one production build across all browser and distributed partitions", async () => {
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  assert.equal((ci.match(/uses: \.\/\.github\/workflows\/acceptance-build.yml/g) ?? []).length, 1);
  assert.doesNotMatch(ci, /command: pnpm test:distributed/);
  assert.match(ci, /uses: \.\/\.github\/workflows\/distributed.yml/);
  assert.match(ci, /needs\.distributed-acceptance\.result/);
  assert.match(ci, /needs\.lite-concurrency\.result/);
  assert.match(ci, /test-offline.sh assets/);
  assert.match(ci, /test-offline.sh recovery/);
  assert.match(ci, /ci-gate:[\s\S]*Check out the cost reporting script[\s\S]*report-ci-cost.mjs/);
  for (const job of [
    "lite-browser",
    "lite-concurrency",
    "system-acceptance",
    "runner-install-acceptance",
    "ldap-acceptance",
    "real-agent-acceptance",
    "container-executor-acceptance",
    "batch-input-sharing-acceptance",
    "unit-integration",
  ]) {
    const block = ci.split(`  ${job}:\n`)[1]?.split(/\n  [a-z][\w-]*:\n/)[0];
    assert.ok(block, job);
    assert.match(block, /needs: build/);
    assert.match(block, /uses: \.\/\.github\/actions\/restore-acceptance-build/);
  }
});

test("release source acceptance starts after publishing and consumes that exact build", async () => {
  const release = await readFile(".github/workflows/release.yml", "utf8");
  const checks = await readFile(".github/workflows/release-checks.yml", "utf8");
  assert.match(release, /extract-release-acceptance-build.sh "\$\{BACKEND_IMAGE\}"/);
  assert.match(release, /name: acceptance-runtime/);
  assert.match(checks, /workflow_run:\n\s+workflows: \[Release\]/);
  assert.doesNotMatch(checks, /push:\n\s+tags:/);
  assert.match(checks, /tag_revision.*!=.*RELEASE_REVISION/);
  assert.match(checks, /run_id: \$\{\{ needs.prepare.outputs.build_run_id \}\}/);
  assert.match(checks, /node scripts\/quality\/prepare-acceptance-build.mjs all/);
});

test("manual source checks reuse only a successfully built artifact for the harness's own commit", async () => {
  const checks = await readFile(".github/workflows/release-checks.yml", "utf8");
  assert.match(checks, /build_run_id:\n\s+description: Optional CI or Release run/);
  assert.match(checks, /checks_revision="\$\{GITHUB_SHA\}"/);
  assert.match(
    checks,
    /acceptance-build-origin.mjs "\$\{REUSE_BUILD_RUN_ID\}" "\$\{checks_revision\}" "\$\{GITHUB_REPOSITORY\}"/,
  );
  assert.match(checks, /run_id: \$\{\{ needs.prepare.outputs.build_run_id \}\}/);
});
