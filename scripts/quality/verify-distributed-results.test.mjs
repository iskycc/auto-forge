import assert from "node:assert/strict";
import test from "node:test";
import { requirePlaywrightSuccess, requireVitestSuccess } from "./verify-distributed-results.mjs";

test("requires executed contract tests without skips or failures", () => {
  assert.doesNotThrow(() =>
    requireVitestSuccess({ success: true, numTotalTests: 4, numPassedTests: 4 }),
  );
  for (const report of [
    { success: true, numTotalTests: 0, numPassedTests: 0 },
    { success: true, numTotalTests: 4, numPassedTests: 3 },
    { success: false, numTotalTests: 4, numPassedTests: 4 },
  ])
    assert.throws(() => requireVitestSuccess(report));
});

test("rejects empty, skipped, failed, retried, expected-failure and hook-error browser reports", () => {
  const passing = { expectedStatus: "passed", status: "expected", results: [{ status: "passed" }] };
  const report = (entry) => ({
    suites: [{ suites: [{ specs: [{ tests: [entry] }] }] }],
    errors: [],
  });
  assert.doesNotThrow(() => requirePlaywrightSuccess(report(passing)));
  for (const invalid of [
    { suites: [] },
    { ...report(passing), errors: [{ message: "teardown failed" }] },
    report({ ...passing, expectedStatus: "failed" }),
    report({ ...passing, status: "skipped" }),
    report({ ...passing, results: [{ status: "failed" }] }),
    report({ ...passing, results: [{ status: "failed" }, { status: "passed" }] }),
  ])
    assert.throws(() => requirePlaywrightSuccess(invalid));
});
