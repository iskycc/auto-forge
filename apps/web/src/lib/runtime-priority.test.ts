import { describe, expect, it } from "vitest";
import { RuntimePriority } from "./runtime-priority";

describe("foreground resource priority", () => {
  it("uses spare capacity while execution is active and yields when its budget is saturated", () => {
    const priority = new RuntimePriority();
    priority.configure(4);
    const first = priority.beginForeground();
    expect(priority.backgroundAllowed()).toBe(true);
    const rest = Array.from({ length: 3 }, () => priority.beginForeground());
    expect(priority.backgroundAllowed()).toBe(false);
    first();
    expect(priority.backgroundAllowed()).toBe(true);
    rest.forEach((finish) => finish());
  });
  it("yields for CPU or memory pressure even without queued foreground work, then recovers", () => {
    let now = 0;
    const priority = new RuntimePriority(() => now);
    priority.observeResources(0.9, 0.8);
    expect(priority.backgroundAllowed()).toBe(false);
    expect(Atomics.load(new Int32Array(priority.signal), 1)).toBe(0);
    now = 5_000;
    expect(priority.backgroundAllowed()).toBe(true);
    priority.observeResources(0.1, 0.1);
    expect(priority.backgroundAllowed()).toBe(false);
    expect(Atomics.load(new Int32Array(priority.signal), 1)).toBe(1);
    expect(priority.pendingIncident()).toBeUndefined();
  });
  it("keeps background work paused until every foreground operation has ended", () => {
    const priority = new RuntimePriority();
    const finishPage = priority.beginForeground();
    const finishUpload = priority.beginForeground();
    expect(Atomics.load(new Int32Array(priority.signal), 0)).toBe(1);
    finishPage();
    finishPage();
    expect(priority.backgroundAllowed()).toBe(false);
    finishUpload();
    expect(priority.backgroundAllowed()).toBe(true);
  });
  it("cools down after a delayed Web event loop and coalesces incidents across retries", () => {
    let now = 10_000;
    const priority = new RuntimePriority(() => now);
    for (let sample = 0; sample <= 40; sample++) {
      priority.observeEventLoopDelay(150);
      if (sample < 40) now += 250;
    }
    const incident = priority.pendingIncident()!;
    expect(incident.kind).toBe("web_pressure");
    priority.observeEventLoopDelay(200);
    expect(priority.pendingIncident()).toEqual(incident);
    expect(priority.backgroundAllowed()).toBe(false);
    now += 5_000;
    expect(priority.backgroundAllowed()).toBe(true);
    priority.acknowledgeIncident(incident.id);
    priority.observeEventLoopDelay(150);
    expect(priority.pendingIncident()).toBeUndefined();
    now += 300_000;
    for (let sample = 0; sample <= 40; sample++) {
      priority.observeEventLoopDelay(150);
      if (sample < 40) now += 250;
    }
    expect(priority.pendingIncident()?.id).not.toBe(incident.id);
  });

  it("protects resources immediately but does not notify for isolated spikes across a simulated day", () => {
    let now = 0;
    const priority = new RuntimePriority(() => now);
    for (now = 0; now < 86_400_000; now += 300_000) {
      priority.observeResources(0.86, 0.8);
      priority.observeEventLoopDelay(101);
      expect(priority.backgroundAllowed()).toBe(false);
      expect(priority.pendingIncident()).toBeUndefined();
      priority.observeResources(0.1, 0.8);
      priority.observeEventLoopDelay(20);
    }
  });

  it("notifies sustained pressure once until recovery instead of every five minutes", () => {
    let now = 0;
    const priority = new RuntimePriority(() => now);
    const incidents: string[] = [];
    for (now = 0; now < 86_400_000; now += 1_000) {
      priority.observeResources(0.9, 0.8);
      const incident = priority.pendingIncident();
      if (incident) {
        expect(now).toBeGreaterThanOrEqual(10_000);
        incidents.push(incident.id);
        priority.acknowledgeIncident(incident.id);
      }
    }
    expect(incidents).toHaveLength(1);
    now += 300_000;
    for (let sample = 0; sample <= 10; sample++, now += 1_000) priority.observeResources(0.9, 0.8);
    expect(priority.pendingIncident()?.kind).toBe("resource_pressure");
    expect(priority.pendingIncident()?.id).not.toBe(incidents[0]);
  });

  it("reports actual failures immediately, keeps their delivery ID stable, and rearms after quiet recovery", () => {
    let now = 0;
    const priority = new RuntimePriority(() => now);
    priority.report("background_refresh");
    const first = priority.pendingIncident()!;
    now = 600_000;
    priority.report("background_refresh");
    expect(priority.pendingIncident()).toEqual(first);
    priority.acknowledgeIncident(first.id);
    for (let retry = 0; retry < 20; retry++, now += 60_000) {
      priority.report("background_refresh");
      expect(priority.pendingIncident()).toBeUndefined();
    }
    now += 300_000;
    priority.report("background_refresh");
    expect(priority.pendingIncident()?.id).not.toBe(first.id);
    expect(priority.pendingIncident()?.kind).toBe("background_refresh");
  });

  it("yields to a short background database lock and notifies only if contention keeps recurring", () => {
    let now = 0;
    const priority = new RuntimePriority(() => now);
    priority.observeDatabaseContention();
    expect(priority.backgroundAllowed()).toBe(false);
    expect(priority.pendingIncident()).toBeUndefined();
    now = 5_000;
    expect(priority.backgroundAllowed()).toBe(true);
    priority.observeDatabaseContention();
    now = 10_000;
    priority.observeDatabaseContention();
    expect(priority.pendingIncident()?.kind).toBe("database_busy");
    const incident = priority.pendingIncident()!;
    priority.acknowledgeIncident(incident.id);
    for (let retry = 0; retry < 100; retry++) {
      now += 30_000;
      priority.observeDatabaseContention();
      expect(priority.pendingIncident()).toBeUndefined();
    }
  });

  it("still reports a failed database operation immediately and pauses ordinary background work", () => {
    const priority = new RuntimePriority();
    priority.report("database_busy");
    expect(priority.pendingIncident()?.kind).toBe("database_busy");
    expect(priority.backgroundAllowed()).toBe(false);
  });
});
