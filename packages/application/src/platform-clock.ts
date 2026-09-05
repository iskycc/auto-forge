import { DomainError } from "@autoforge/domain";
import type { Clock } from "./ports";

const MAXIMUM_SAMPLE_AGE_MS = 120_000;
const MAXIMUM_ROUND_TRIP_MS = 2_000;
const MAXIMUM_CORRECTION_MS = 2_000;
const CORRECTION_RATE = 0.05;

export type PlatformClockStatus = {
  source: "local" | "postgres";
  state: "synchronized" | "holdover" | "unavailable";
  lastSynchronizedAt: string | null;
  sampleAgeMs: number | null;
};

/** Wall time is sampled at the boundary; all progress and freshness use elapsed time. */
export class PlatformClock implements Clock {
  private epochMs = 0;
  private progressedAtMs = 0;
  private sampledAtMs: number | undefined;
  private sampledEpochMs: number | undefined;
  private correctionMs = 0;
  private failure: unknown;

  constructor(
    private readonly source: PlatformClockStatus["source"],
    private readonly monotonicNow: () => number,
  ) {}

  now(): Date {
    if (this.status().state === "unavailable") {
      throw new DomainError(
        "PLATFORM_CLOCK_UNAVAILABLE",
        "统一时间基准不可用，请检查 PostgreSQL 连接及数据库时间；恢复校时后自动继续。",
        { cause: this.failure },
      );
    }
    return new Date(Math.floor(this.advance()));
  }

  synchronize(serverEpochMs: number, requestedAtMs: number, receivedAtMs: number): void {
    const roundTripMs = receivedAtMs - requestedAtMs;
    if (
      !Number.isFinite(serverEpochMs) ||
      !Number.isFinite(roundTripMs) ||
      roundTripMs < 0 ||
      roundTripMs > MAXIMUM_ROUND_TRIP_MS
    )
      throw new Error("统一时间采样无效或往返耗时超过 2 秒。");
    const estimatedEpochMs = serverEpochMs + roundTripMs / 2;
    if (this.sampledAtMs === undefined) {
      this.epochMs = estimatedEpochMs;
      this.progressedAtMs = receivedAtMs;
    } else {
      const correctionMs = estimatedEpochMs - this.advance();
      if (Math.abs(correctionMs) > MAXIMUM_CORRECTION_MS) {
        throw new Error("数据库时间发生超过 2 秒的跳变，保留单调时间并等待时间源恢复。");
      }
      // Slew small drift instead of making active durations go backwards.
      this.correctionMs = correctionMs;
    }
    this.sampledAtMs = receivedAtMs;
    this.sampledEpochMs = estimatedEpochMs;
    this.failure = undefined;
  }

  recordFailure(error: unknown): void {
    this.failure = error;
  }

  status(): PlatformClockStatus {
    const sampleAgeMs =
      this.sampledAtMs === undefined
        ? null
        : Math.max(0, Math.floor(this.monotonicNow() - this.sampledAtMs));
    const unavailable =
      sampleAgeMs === null || (this.source === "postgres" && sampleAgeMs >= MAXIMUM_SAMPLE_AGE_MS);
    return {
      source: this.source,
      state: unavailable
        ? "unavailable"
        : this.source === "postgres" && (this.failure !== undefined || sampleAgeMs! > 15_000)
          ? "holdover"
          : "synchronized",
      lastSynchronizedAt:
        this.sampledEpochMs === undefined ? null : new Date(this.sampledEpochMs).toISOString(),
      sampleAgeMs,
    };
  }

  private advance(): number {
    const nowMs = this.monotonicNow();
    const elapsedMs = Math.max(0, nowMs - this.progressedAtMs);
    const correctionMs =
      Math.sign(this.correctionMs) *
      Math.min(Math.abs(this.correctionMs), elapsedMs * CORRECTION_RATE);
    this.epochMs += elapsedMs + correctionMs;
    this.correctionMs -= correctionMs;
    this.progressedAtMs = nowMs;
    return this.epochMs;
  }
}

export type ManagedPlatformClock = PlatformClock & { close(): Promise<void> };
