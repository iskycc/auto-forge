/** Bounded per-process suppression; metrics and authentication responses remain unsampled. */
export class RunnerAuthLogSampler {
  private readonly windows = new Map<string, { nextAt: number; suppressed: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60_000,
    private readonly maximumKeys = 1024,
  ) {}

  sample(
    path: string,
    statusCode: number,
    runnerIdHeader?: string,
  ): { suppressedRequests?: number } | null {
    if (statusCode !== 401) return {};
    const agent = /^\/api\/v1\/runner-agents\/([a-z0-9-]{1,128})\//iu.exec(path);
    const attempt = /^\/api\/v1\/run-attempts\/[^/]+\//u.test(path);
    const key =
      agent?.[1] ??
      (attempt && runnerIdHeader && /^[a-z0-9-]{1,128}$/iu.test(runnerIdHeader)
        ? runnerIdHeader
        : undefined);
    if (!key) return {};
    const now = this.now();
    const existing = this.windows.get(key);
    if (existing && now < existing.nextAt) {
      existing.suppressed = Math.min(Number.MAX_SAFE_INTEGER, existing.suppressed + 1);
      return null;
    }
    if (!existing && this.windows.size >= this.maximumKeys) {
      const oldest = this.windows.keys().next().value!;
      const previous = this.windows.get(oldest)!;
      if (previous.nextAt > now) return null;
      this.windows.delete(oldest);
    }
    this.windows.set(key, { nextAt: now + this.windowMs, suppressed: 0 });
    return existing?.suppressed ? { suppressedRequests: existing.suppressed } : {};
  }
}
