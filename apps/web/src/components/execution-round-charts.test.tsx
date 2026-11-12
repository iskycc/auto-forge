import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExecutionBatchView } from "@/lib/execution-batch-view";
import { ExecutionRoundCharts } from "./execution-round-charts";

const timestamp = "2026-11-12T00:00:00.000Z";
function fixture(): ExecutionBatchView {
  const total = {
    totalRuns: 100,
    passed: 94,
    failed: 6,
    timedOut: 0,
    cancelled: 0,
    notExecuted: 0,
    passRate: 94,
  };
  return {
    id: "batch",
    status: "failed",
    retryLimit: 1,
    retryMode: "round",
    currentRound: 2,
    totalRuns: 100,
    succeededRuns: 94,
    failedRuns: 6,
    timedOutRuns: 0,
    scheduledFor: timestamp,
    updatedAt: timestamp,
    finalSummary: total,
    allRoundsSummary: { ...total, totalRuns: 110, failed: 16, passRate: 85 },
    roundSummaries: [
      {
        round: 1,
        status: "completed",
        totalRuns: 100,
        executed: 100,
        passed: 90,
        failed: 10,
        timedOut: 0,
        cancelled: 0,
        notExecuted: 0,
        roundPassRate: 90,
        overallPassed: 90,
        overallPassRate: 90,
        startedAt: timestamp,
        durationMs: 1000,
      },
      {
        round: 2,
        status: "completed",
        totalRuns: 10,
        executed: 10,
        passed: 4,
        failed: 6,
        timedOut: 0,
        cancelled: 0,
        notExecuted: 0,
        roundPassRate: 40,
        overallPassed: 94,
        overallPassRate: 94,
        startedAt: timestamp,
        durationMs: 1000,
      },
    ],
    roundRecoveries: [],
    roundConcurrencies: [],
    runnerRoundSummaries: [],
    runnerFaultIncidents: [],
    finishedAt: timestamp,
  };
}
function render(batch: ExecutionBatchView, round: number | "summary" | "all") {
  return renderToStaticMarkup(
    <ExecutionRoundCharts batch={batch} round={round} label="选择范围" />,
  );
}
describe("execution chart scope", () => {
  it("does not turn 90 earlier passes into unexecuted cases in the retry round", () => {
    const html = render(fixture(), 2);
    expect(html).toContain("通过 4，失败 6，超时 0，进行中 0，取消 0，未执行 0");
    expect(html).not.toContain("未执行 90");
  });
  it("counts only this round's waiting, active and terminal members", () => {
    const batch = fixture();
    batch.roundSummaries[1] = {
      ...batch.roundSummaries[1]!,
      status: "running",
      executed: 4,
      passed: 1,
      failed: 1,
      timedOut: 0,
      cancelled: 1,
      notExecuted: 6,
    };
    expect(render(batch, 2)).toContain("通过 1，失败 1，超时 0，进行中 1，取消 1，未执行 6");
  });
  it("keeps a released empty retry round empty, including a paused scheduling window", () => {
    const batch = fixture();
    batch.roundSummaries[1] = {
      ...batch.roundSummaries[1]!,
      status: "waiting",
      totalRuns: 0,
      executed: 0,
      passed: 0,
      failed: 0,
      timedOut: 0,
      cancelled: 0,
      notExecuted: 0,
      roundPassRate: null,
    };
    expect(render(batch, 2)).toContain("通过 0，失败 0，超时 0，进行中 0，取消 0，未执行 0");
    batch.roundSummaries[1] = { ...batch.roundSummaries[1]!, totalRuns: 10, notExecuted: 10 };
    expect(render(batch, 2)).toContain("通过 0，失败 0，超时 0，进行中 0，取消 0，未执行 10");
  });

  it("keeps summary de-duplication and all-round totals independent", () => {
    expect(render(fixture(), "summary")).toContain(
      "通过 94，失败 6，超时 0，进行中 0，取消 0，未执行 0",
    );
    expect(render(fixture(), "all")).toContain(
      "通过 94，失败 16，超时 0，进行中 0，取消 0，未执行 0",
    );
  });
  it("does not substitute final results when a selected round has no statistics", () => {
    const html = render(fixture(), 3);
    expect(html).not.toContain("通过 94，失败 6");
  });
});
