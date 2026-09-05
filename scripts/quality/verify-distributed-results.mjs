import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function requireVitestSuccess(report) {
  assert.equal(report.success, true, "Contract suite failed");
  assert.ok(report.numTotalTests > 0, "Contract suite executed no tests");
  assert.equal(
    report.numPassedTests,
    report.numTotalTests,
    "Contract tests were skipped or failed",
  );
}

export function requirePlaywrightSuccess(report) {
  assert.deepEqual(report.errors ?? [], [], "Playwright reported global errors");
  const tests = [];
  function visit(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) tests.push(...spec.tests);
      visit(suite.suites ?? []);
    }
  }
  visit(report.suites ?? []);
  assert.ok(tests.length > 0, "Playwright executed no tests");
  for (const test of tests) {
    assert.equal(
      test.expectedStatus,
      "passed",
      "Expected failures cannot satisfy distributed acceptance",
    );
    assert.equal(test.status, "expected", "Playwright case failed or was skipped/flaky");
    assert.equal(test.results.length, 1, "Retries cannot hide distributed races");
    assert.equal(test.results[0].status, "passed", "Playwright case did not pass");
  }
}

async function verify(phase) {
  assert.ok(
    ["distributed-contracts", "browser-distributed", "distributed-agent"].includes(phase),
    "Unknown distributed phase",
  );
  const directory = resolve("test-results/distributed", phase);
  const readReport = async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8"));
  assert.equal(
    (await readReport("fixture.json")).exitStatus,
    0,
    "Fixture did not finish successfully",
  );
  if (phase === "distributed-contracts") requireVitestSuccess(await readReport("contracts.json"));
  else {
    requirePlaywrightSuccess(await readReport("browser.json"));
    if (phase === "distributed-agent") requirePlaywrightSuccess(await readReport("agent.json"));
  }
  process.stdout.write(`Verified non-skipped distributed evidence: ${phase}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verify(process.argv[2]);
}
