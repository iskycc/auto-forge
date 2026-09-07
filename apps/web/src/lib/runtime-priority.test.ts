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
    expect(priority.pendingIncident()?.kind).toBe("resource_pressure");
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
    priority.observeEventLoopDelay(150);
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
    priority.observeEventLoopDelay(150);
    expect(priority.pendingIncident()?.id).not.toBe(incident.id);
  });
});
