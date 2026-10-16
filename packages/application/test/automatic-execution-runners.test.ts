import { describe, expect, it, vi } from "vitest";
import type { Runner } from "@autoforge/domain";
import { automaticExecutionRunnerIds } from "../src/automatic-execution-runners";

const cutoff = "2026-10-15T00:00:00Z";
function compatibleRunner(id: string): Runner {
  return {
    id,
    name: id,
    state: "online",
    os: "linux",
    architecture: "amd64",
    agentVersion: "1.19.22",
    protocolVersion: 1,
    labels: ["java", "testng"],
    capabilities: [
      "executor:testng-v1",
      "isolation:cgroup-v2",
      "java:21",
      "testng:7.11.0",
      "adapter:cotest-testng-v1",
    ],
    maxConcurrency: 2,
    busySlots: 2,
    terminalEnabled: false,
    credentialVersion: 1,
    lastSeenAt: cutoff,
    createdAt: cutoff,
    updatedAt: cutoff,
  };
}

describe("automatic execution Runner selection", () => {
  it("continues past an ineligible page and includes busy compatible nodes for normal queuing", async () => {
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ ...compatibleRunner("old"), state: "offline" }],
        nextCursor: "old",
      })
      .mockResolvedValueOnce({ items: [compatibleRunner("ready")] });
    expect(
      await automaticExecutionRunnerIds({ listPage }, cutoff, ["adapter:cotest-testng-v1"]),
    ).toEqual(["ready"]);
    expect(listPage.mock.calls).toEqual([
      [cutoff, { limit: 64 }],
      [cutoff, { afterId: "old", limit: 64 }],
    ]);
  });

  it.each([
    { state: "offline" },
    { state: "draining" },
    { state: "disabled" },
    { credentialRevokedAt: cutoff },
    { deregisteredAt: cutoff },
    { purgedAt: cutoff },
    { protocolVersion: 99 },
    { labels: ["java"] },
    { capabilities: [] },
  ] satisfies Partial<Runner>[])("rejects an ineligible automatic pool: %j", async (override) => {
    const listPage = vi
      .fn()
      .mockResolvedValue({ items: [{ ...compatibleRunner("invalid"), ...override }] });
    await expect(automaticExecutionRunnerIds({ listPage }, cutoff, [])).rejects.toMatchObject({
      code: "RUNNER_AUTO_SELECTION_EMPTY",
    });
  });

  it("requires all additional DDT capabilities", async () => {
    const listPage = vi.fn().mockResolvedValue({ items: [compatibleRunner("ordinary-only")] });
    await expect(
      automaticExecutionRunnerIds({ listPage }, cutoff, ["adapter:ddt-insight-url-v1"]),
    ).rejects.toMatchObject({ code: "RUNNER_AUTO_SELECTION_EMPTY" });
  });

  it("freezes at most 64 eligible runners and stops reading further pages", async () => {
    const listPage = vi.fn().mockResolvedValue({
      items: Array.from({ length: 64 }, (_, index) => compatibleRunner(`runner-${index}`)),
      nextCursor: "runner-63",
    });
    expect(await automaticExecutionRunnerIds({ listPage }, cutoff, [])).toHaveLength(64);
    expect(listPage).toHaveBeenCalledTimes(1);
  });
});
