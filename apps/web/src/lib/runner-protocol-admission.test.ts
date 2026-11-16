import { describe, expect, it, vi } from "vitest";
import { MemoryRequestLimiter } from "./request-limiter";
import {
  admitRunnerProtocolResource,
  createRunnerProtocolAdmission,
} from "./runner-protocol-admission";

describe("Runner protocol traffic budgets", () => {
  it("shares a Full platform budget of 1000 uploads per second across nodes and resets it independently of renewals", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new MemoryRequestLimiter();
      const web = createRunnerProtocolAdmission(limiter, { requests: 1_000, windowMs: 1_000 });
      const peer = createRunnerProtocolAdmission(limiter, { requests: 1_000, windowMs: 1_000 });
      for (let request = 0; request < 1_000; request++)
        await (request % 2 ? web : peer).assertAllowed({
          operation: "logs",
          runnerId: `runner-${request % 10}`,
          maximumConcurrency: 1,
        });
      await expect(
        web.assertAllowed({ operation: "logs", runnerId: "runner-next", maximumConcurrency: 1 }),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      await expect(
        web.assertAllowed({
          operation: "renew-lease",
          runnerId: "runner-next",
          maximumConcurrency: 1,
        }),
      ).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(
        peer.assertAllowed({ operation: "logs", runnerId: "runner-next", maximumConcurrency: 1 }),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it("supports ten slots at the normal 2 Hz upload cadence without sharing one slot's quota", async () => {
    const limiter = new MemoryRequestLimiter();
    const admission = createRunnerProtocolAdmission(limiter);
    for (let tick = 0; tick < 120; tick++) {
      for (let slot = 0; slot < 10; slot++) {
        await admitRunnerProtocolResource(limiter, "logs", "runner", `attempt-${slot}`);
        await admission.assertAllowed({
          operation: "logs",
          runnerId: "runner",
          maximumConcurrency: 10,
        });
      }
    }
  });
  it("limits a noisy attempt while preserving peer, completion and renewal budgets", async () => {
    const limiter = new MemoryRequestLimiter();
    for (let request = 0; request < 600; request++)
      await admitRunnerProtocolResource(limiter, "logs", "runner", "noisy");
    await expect(
      admitRunnerProtocolResource(limiter, "logs", "runner", "noisy"),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(
      admitRunnerProtocolResource(limiter, "logs", "runner", "peer"),
    ).resolves.toBeUndefined();
    await expect(
      admitRunnerProtocolResource(limiter, "complete", "runner", "noisy"),
    ).resolves.toBeUndefined();
    await expect(
      admitRunnerProtocolResource(limiter, "renew-lease", "runner", "lease"),
    ).resolves.toBeUndefined();
  });
  it("retains an aggregate node ceiling based on authenticated capacity", async () => {
    const admission = createRunnerProtocolAdmission(new MemoryRequestLimiter());
    const input = { operation: "logs" as const, runnerId: "runner", maximumConcurrency: 10 };
    for (let request = 0; request < 1800; request++) await admission.assertAllowed(input);
    await expect(admission.assertAllowed(input)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(
      admission.assertAllowed({ ...input, operation: "renew-lease" }),
    ).resolves.toBeUndefined();
  });
});
