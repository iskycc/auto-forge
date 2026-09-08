const ACTIVE_INTERVAL_MS = 1_000;
const MAXIMUM_IDLE_INTERVAL_MS = 30_000;

/** Avoid rescanning completed history every second when no new facts are available. */
export class AnalyticsFactRefresh {
  private nextRefreshAt = 0;
  private idleIntervalMs = ACTIVE_INTERVAL_MS;

  constructor(
    private readonly rebuild: () => Promise<number>,
    private readonly reportError: (error: unknown) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async refreshIfDue(): Promise<void> {
    if (this.now() < this.nextRefreshAt) return;
    let producedFacts = false;
    try {
      producedFacts = (await this.rebuild()) > 0;
    } catch (error) {
      // A failed fact scan must not prevent an independent cold page from being built.
      this.reportError(error);
    }
    const intervalMs = producedFacts ? ACTIVE_INTERVAL_MS : this.idleIntervalMs;
    this.nextRefreshAt = this.now() + intervalMs;
    this.idleIntervalMs = producedFacts
      ? ACTIVE_INTERVAL_MS
      : Math.min(MAXIMUM_IDLE_INTERVAL_MS, intervalMs * 2);
  }
}
