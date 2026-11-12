import type { Clock, RunnerRepository } from "./ports";

const CONTACT_WINDOW_MS = 60_000;
const MAXIMUM_CONTACT_KEYS = 1024;
const MAXIMUM_WINDOW_PROBES = 120;

/** Diagnostics never grant execution rights or trust metadata supplied by a rejected Agent. */
export class DeletedRunnerContactService {
  private readonly nextProbeAt = new Map<string, number>();
  private windowStartedAt = 0;
  private windowProbes = 0;

  constructor(
    private readonly runners: Pick<
      RunnerRepository,
      "recordRejectedContact" | "listRejectedContacts"
    >,
    private readonly clock: Clock,
    private readonly reportFailure: (cause: unknown) => void,
  ) {}

  async observe(runnerId: string): Promise<void> {
    // Unknown names and malformed ids cannot grow the durable diagnostic directory.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(runnerId)) return;
    const now = this.clock.now();
    const timestamp = now.getTime();
    if ((this.nextProbeAt.get(runnerId) ?? 0) > timestamp) return;
    if (timestamp - this.windowStartedAt >= CONTACT_WINDOW_MS || timestamp < this.windowStartedAt) {
      this.windowStartedAt = timestamp;
      this.windowProbes = 0;
    }
    if (this.windowProbes >= MAXIMUM_WINDOW_PROBES) return;
    this.windowProbes++;
    if (this.nextProbeAt.size >= MAXIMUM_CONTACT_KEYS)
      this.nextProbeAt.delete(this.nextProbeAt.keys().next().value!);
    this.nextProbeAt.set(runnerId, timestamp + CONTACT_WINDOW_MS);
    try {
      await this.runners.recordRejectedContact({
        runnerId,
        recordedAt: now.toISOString(),
        previousWindowBefore: new Date(timestamp - CONTACT_WINDOW_MS).toISOString(),
      });
    } catch (cause) {
      // The original protocol response remains 401 even if diagnostics cannot be persisted.
      this.reportFailure(cause);
    }
  }

  list(query: { afterId?: string; limit: number }) {
    return this.runners.listRejectedContacts(query);
  }
}
