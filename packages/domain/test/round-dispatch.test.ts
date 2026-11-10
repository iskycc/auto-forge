import { describe, expect, it } from "vitest";
import {
  roundDispatchTarget,
  roundNeedsCompleteStatistics,
  roundWindowConcurrency,
} from "../src/round-dispatch";

describe("two-round dispatch window", () => {
  const tail = {
    currentRound: 1,
    nextHeldRound: 2,
    oldestActiveRound: 1,
    hasQueuedWork: false,
    requiresCompletedRound: false,
  };

  it("fills spare slots from the adjacent round, without opening an empty round", () => {
    expect(roundDispatchTarget(tail)).toBe(2);
    expect(roundDispatchTarget({ ...tail, nextHeldRound: null })).toBeNull();
    expect(roundDispatchTarget({ ...tail, nextHeldRound: 3 })).toBeNull();
    expect(roundDispatchTarget({ ...tail, hasQueuedWork: true })).toBeNull();
  });

  it("shares the smaller configured cap while two rounds overlap", () => {
    expect(roundWindowConcurrency(30, 50)).toBe(30);
    expect(roundWindowConcurrency(50, 30)).toBe(30);
    expect(roundWindowConcurrency(50, null)).toBe(50);
    expect(roundWindowConcurrency(undefined, 30)).toBe(30);
    expect(roundWindowConcurrency(undefined, undefined)).toBeUndefined();
  });

  it("never opens a third round while an older round is in flight", () => {
    expect(roundDispatchTarget({ ...tail, currentRound: 2, nextHeldRound: 3 })).toBeNull();
    expect(
      roundDispatchTarget({ ...tail, currentRound: 2, nextHeldRound: 3, oldestActiveRound: 2 }),
    ).toBe(3);
  });

  it("admits late failures into the already open round, even with queued work", () => {
    expect(
      roundDispatchTarget({ ...tail, currentRound: 2, nextHeldRound: 2, hasQueuedWork: true }),
    ).toBe(2);
  });

  it("waits for statistics only for applicable result-dependent rules", () => {
    const policy = JSON.stringify({
      retryConcurrencyRules: [
        { id: "conditional", executionRound: 2, concurrency: 10, previousRoundPassRateMinimum: 0 },
        { id: "fixed", executionRound: 3, concurrency: 10 },
      ],
    });
    expect(roundNeedsCompleteStatistics(policy, 2)).toBe(true);
    expect(roundNeedsCompleteStatistics(policy, 3)).toBe(false);
    expect(roundNeedsCompleteStatistics(null, 2)).toBe(false);
  });

  it("preserves statistics barriers in historical retry rules and tolerates absent legacy arrays", () => {
    const policy = JSON.stringify({
      retryConcurrencyRules: [
        {
          id: "legacy",
          executionRoundFrom: 2,
          executionRoundTo: 4,
          concurrency: 5,
          previousRoundPassRateMinimum: 50,
        },
      ],
    });
    expect(roundNeedsCompleteStatistics(policy, 2)).toBe(true);
    expect(roundNeedsCompleteStatistics(policy, 3)).toBe(false);
    for (const legacyValue of [null, false, {}, "legacy"]) {
      expect(
        roundNeedsCompleteStatistics(JSON.stringify({ retryConcurrencyRules: legacyValue }), 2),
      ).toBe(false);
    }
  });

  it("preserves environment recovery and result-dependent concurrency barriers", () => {
    expect(roundDispatchTarget({ ...tail, requiresCompletedRound: true })).toBeNull();
    expect(
      roundDispatchTarget({ ...tail, requiresCompletedRound: true, oldestActiveRound: null }),
    ).toBe(2);
  });

  it("keeps the window bounded and drains under reproducible reordered failures and infrastructure retries", () => {
    for (let seed = 1; seed <= 50; seed++) {
      let randomState = seed;
      const pick = (limit: number) => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState % limit;
      };
      const runs = Array.from({ length: 24 }, () => ({
        round: 1,
        held: false,
        status: "queued" as "queued" | "active" | "completed",
      }));
      let currentRound = 1;
      for (let step = 0; step < 1000; step++) {
        const active = runs.filter((run) => run.status === "active");
        const held = runs.filter((run) => run.status === "queued" && run.held);
        const ready = runs.filter((run) => run.status === "queued" && !run.held);
        const target = roundDispatchTarget({
          currentRound,
          nextHeldRound: held.length ? Math.min(...held.map((run) => run.round)) : null,
          oldestActiveRound: active.length ? Math.min(...active.map((run) => run.round)) : null,
          hasQueuedWork: ready.length > 0,
          requiresCompletedRound: currentRound % 3 === 0,
        });
        const trace = `seed=${seed}, step=${step}, openRound=${currentRound}`;
        if (target !== null) {
          expect(
            held.some((run) => run.round <= target),
            trace,
          ).toBe(true);
          for (const run of held) if (run.round <= target) run.held = false;
          currentRound = target;
        }
        // Even a complete-round barrier must resume once the previous work is drained.
        if (!active.length && !ready.length && held.length) expect(target, trace).not.toBeNull();

        const candidates = runs.filter((run) => run.status === "queued" && !run.held);
        while (active.length < 5 && candidates.length) {
          const [run] = candidates.splice(pick(candidates.length), 1);
          run!.status = "active";
          active.push(run!);
        }
        const rounds = new Set(active.map((run) => run.round));
        expect(rounds.size, trace).toBeLessThanOrEqual(2);
        if (rounds.size)
          expect(Math.max(...rounds) - Math.min(...rounds), trace).toBeLessThanOrEqual(1);
        if (!active.length) break;
        const completed = active[pick(active.length)]!;
        const outcome = pick(10);
        if (outcome === 0) {
          completed.status = "queued"; // Runner failure retries its original logical round.
        } else if (outcome < 7 && completed.round < 6) {
          completed.round++;
          completed.status = "queued";
          completed.held = true;
        } else {
          completed.status = "completed";
        }
      }
      expect(
        runs.every((run) => run.status === "completed"),
        `seed=${seed}`,
      ).toBe(true);
    }
  });
});
