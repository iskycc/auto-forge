import { describe, expect, it } from "vitest";

import { PublicPlatformStatisticsService } from "../src/read-public-statistics";

describe("public platform statistics", () => {
  it("calculates a bounded success rate from terminal outcomes", async () => {
    let observedOnlineSince = "";
    const service = new PublicPlatformStatisticsService(
      {
        read: async (onlineSince) => {
          observedOnlineSince = onlineSince;
          return {
            sourceCount: 2,
            caseCount: 4,
            methodCount: 10,
            enabledMethodCount: 9,
            runnerCount: 3,
            onlineRunnerCount: 2,
            busyRunnerCount: 1,
            activeBatchCount: 1,
            completedBatchCount: 5,
            totalRunCount: 10,
            succeededRunCount: 7,
            failedRunCount: 3,
          };
        },
      },
      { now: () => new Date("2026-08-11T00:01:00.000Z") },
      60_000,
      15,
    );

    await expect(service.read()).resolves.toMatchObject({
      successRatePercent: 70,
      generatedAt: "2026-08-11T00:01:00.000Z",
      refreshSeconds: 15,
    });
    expect(observedOnlineSince).toBe("2026-08-11T00:00:00.000Z");
  });
});
