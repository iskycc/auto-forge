import type { PublicPlatformStatistics } from "@autoforge/contracts";

import type { Clock, PlatformStatisticsRepository } from "./ports";

export class PublicPlatformStatisticsService {
  constructor(
    private readonly repository: PlatformStatisticsRepository,
    private readonly clock: Clock,
    private readonly runnerOnlineWindowMs: number,
    private readonly refreshSeconds: number,
  ) {}

  async read(): Promise<PublicPlatformStatistics> {
    const now = this.clock.now();
    const onlineSince = new Date(now.getTime() - this.runnerOnlineWindowMs).toISOString();
    const snapshot = await this.repository.read(onlineSince);
    const completedRuns = snapshot.succeededRunCount + snapshot.failedRunCount;
    return {
      ...snapshot,
      successRatePercent:
        completedRuns === 0
          ? 0
          : Math.round((snapshot.succeededRunCount / completedRuns) * 1_000) / 10,
      generatedAt: now.toISOString(),
      refreshSeconds: this.refreshSeconds,
    };
  }
}
