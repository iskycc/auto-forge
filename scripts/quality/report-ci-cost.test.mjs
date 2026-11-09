import assert from "node:assert/strict";
import test from "node:test";
import { summarizeJobCosts } from "./report-ci-cost.mjs";

test("counts parallel runtime rather than queue time, including failed and running jobs", () => {
  const start = "2026-11-09T00:00:00Z";
  const result = summarizeJobCosts(
    [
      {
        name: "build",
        started_at: start,
        completed_at: "2026-11-09T00:02:00Z",
        status: "completed",
        conclusion: "success",
      },
      {
        name: "tests",
        started_at: start,
        completed_at: "2026-11-09T00:03:00Z",
        status: "completed",
        conclusion: "failure",
      },
      { name: "gate", started_at: start, status: "in_progress" },
      { name: "queued", started_at: start, status: "queued" },
    ],
    Date.parse("2026-11-09T00:01:00Z"),
  );
  assert.equal(result.totalMinutes, 6);
  assert.deepEqual(
    result.slowest.map((job) => job.name),
    ["tests", "build", "gate"],
  );
});
