export type RuntimeIncidentKind =
  | "log_io"
  | "background_refresh"
  | "web_pressure"
  | "database_busy"
  | "execution_control"
  | "resource_pressure";
export type RuntimeIncident = { id: string; kind: RuntimeIncidentKind; createdAt: string };

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
  private readonly reportedAt = new Map<RuntimeIncidentKind, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  configure(foregroundCapacity: number): void {
    this.foregroundCapacity = Math.max(1, foregroundCapacity);
    this.update();
  }

  observeResources(cpuUtilization: number, availableMemoryRatio: number): void {
    if (availableMemoryRatio < 0.15) this.memoryPressureUntil = this.now() + 5_000;
    if (cpuUtilization >= 0.85 || availableMemoryRatio < 0.15) {
      this.pressureUntil = this.now() + 5_000;
      this.report("resource_pressure");
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
      this.pressureUntil = this.now() + 5_000;
      this.report("web_pressure");
    }
    this.update();
  }

  backgroundAllowed(): boolean {
    this.update();
    return Atomics.load(this.paused, 0) === 0;
  }

  report(kind: RuntimeIncidentKind): void {
    const now = this.now();
    if (this.incidents.has(kind) || now - (this.reportedAt.get(kind) ?? -Infinity) < 300_000)
      return;
    this.reportedAt.set(kind, now);
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
