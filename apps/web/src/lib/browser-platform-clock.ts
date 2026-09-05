/** Browser wall time is deliberately excluded from execution and scheduling displays. */
export class BrowserPlatformClock {
  private anchoredAtMs: number;
  constructor(
    private epochMs: number,
    private readonly monotonicNow: () => number,
  ) {
    this.anchoredAtMs = monotonicNow();
  }

  now(): number {
    return this.epochMs + Math.max(0, this.monotonicNow() - this.anchoredAtMs);
  }

  synchronize(serverEpochMs: number, requestedAtMs: number, receivedAtMs: number): void {
    const roundTripMs = receivedAtMs - requestedAtMs;
    if (!Number.isFinite(serverEpochMs) || roundTripMs < 0 || roundTripMs > 5_000) {
      throw new Error("平台时间响应无效或请求耗时过长。");
    }
    this.epochMs = serverEpochMs + roundTripMs / 2;
    this.anchoredAtMs = receivedAtMs;
  }
}
