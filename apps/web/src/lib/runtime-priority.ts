export type RuntimeIncidentKind =
  | "log_io"
  | "background_refresh"
  | "web_pressure"
  | "database_busy"
  | "execution_control"
  | "resource_pressure";
export type RuntimeIncident = { id: string; kind: RuntimeIncidentKind; createdAt: string };

const PRESSURE_COOLDOWN_MS = 5_000;
const SUSTAINED_PRESSURE_MS = 10_000;
const INCIDENT_RECOVERY_MS = 300_000;
type PressureObservation = { firstAt: number; lastAt: number; count: number };

/** A shared flag lets a SQLite worker see foreground pressure without waiting on its event loop. */
export class RuntimePriority {
  // Slot 0 pauses ordinary background work; slot 1 also pauses the one initial-page builder.
  readonly signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  private readonly paused = new Int32Array(this.signal);
  private foreground = 0;
  private foregroundCapacity = 1;
  private pressureUntil = 0;
  private memoryPressureUntil = 0;
  private readonly incidents = new Map<RuntimeIncidentKind, RuntimeIncident>();
  private readonly lastFailureAt = new Map<RuntimeIncidentKind, number>();
  private readonly pressure = new Map<RuntimeIncidentKind, PressureObservation>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  configure(foregroundCapacity: number): void {
    this.foregroundCapacity = Math.max(1, foregroundCapacity);
    this.update();
  }

  observeResources(cpuUtilization: number, availableMemoryRatio: number): void {
    if (availableMemoryRatio < 0.15) this.memoryPressureUntil = this.now() + PRESSURE_COOLDOWN_MS;
    if (cpuUtilization >= 0.85 || availableMemoryRatio < 0.15) {
      this.pressureUntil = this.now() + PRESSURE_COOLDOWN_MS;
      this.observePressure("resource_pressure", PRESSURE_COOLDOWN_MS);
    }
    this.update();
  }

  beginForeground(): () => void {
    this.foreground += 1;
    this.update();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.foreground -= 1;
      this.update();
    };
  }

  observeEventLoopDelay(durationMs: number): void {
    if (durationMs >= 100) {
      this.pressureUntil = this.now() + PRESSURE_COOLDOWN_MS;
      this.observePressure("web_pressure", PRESSURE_COOLDOWN_MS);
    }
    this.update();
  }

  backgroundAllowed(): boolean {
    this.update();
    return Atomics.load(this.paused, 0) === 0;
  }

  /** Expected background lock deferrals yield immediately; repeated contention is actionable. */
  observeDatabaseContention(): void {
    this.pressureUntil = this.now() + PRESSURE_COOLDOWN_MS;
    // Fact refreshes back off up to 30 seconds, so observations need not arrive every sample.
    this.observePressure("database_busy", 60_000);
    this.update();
  }

  report(kind: RuntimeIncidentKind): void {
    const now = this.now();
    if (kind === "database_busy") {
      this.pressureUntil = now + PRESSURE_COOLDOWN_MS;
      this.update();
    }
    const previousFailureAt = this.lastFailureAt.get(kind);
    this.lastFailureAt.set(kind, now);
    if (
      this.incidents.has(kind) ||
      (previousFailureAt !== undefined && now - previousFailureAt < INCIDENT_RECOVERY_MS)
    )
      return;
    this.incidents.set(kind, {
      id: crypto.randomUUID(),
      kind,
      createdAt: new Date().toISOString(),
    });
  }

  pendingIncident(): RuntimeIncident | undefined {
    return this.incidents.values().next().value;
  }

  acknowledgeIncident(id: string): void {
    for (const [kind, incident] of this.incidents)
      if (incident.id === id) this.incidents.delete(kind);
  }

  private observePressure(kind: RuntimeIncidentKind, maximumGapMs: number): void {
    const now = this.now();
    const previous = this.pressure.get(kind);
    const observation =
      previous && now - previous.lastAt < maximumGapMs
        ? { firstAt: previous.firstAt, lastAt: now, count: previous.count + 1 }
        : { firstAt: now, lastAt: now, count: 1 };
    this.pressure.set(kind, observation);
    if (observation.count >= 3 && now - observation.firstAt >= SUSTAINED_PRESSURE_MS)
      this.report(kind);
  }

  private update(): void {
    Atomics.store(this.paused, 1, Number(this.now() < this.memoryPressureUntil));
    Atomics.store(
      this.paused,
      0,
      Number(this.foreground >= this.foregroundCapacity || this.now() < this.pressureUntil),
    );
  }
}

const runtime = globalThis as typeof globalThis & { __autoforgePriority?: RuntimePriority };
export function runtimePriority(): RuntimePriority {
  return (runtime.__autoforgePriority ??= new RuntimePriority());
}
