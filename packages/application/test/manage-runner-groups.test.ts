import { describe, expect, it, vi } from "vitest";
import type { Runner } from "@autoforge/domain";

import { RunnerGroupService } from "../src/manage-runner-groups";
import type { RunnerGroupRepository, RunnerRepository } from "../src/ports";

const now = new Date("2026-08-20T00:00:00.000Z");

function serviceWith(
  groups: Partial<RunnerGroupRepository>,
  runners: Partial<RunnerRepository> = {
    get: vi.fn(async (runnerId: string) => runnerRecord(runnerId)),
  },
) {
  return new RunnerGroupService(
    groups as RunnerGroupRepository,
    runners as RunnerRepository,
    { now: () => new Date(now.getTime()) },
    { next: () => "group-1" },
  );
}

describe("RunnerGroupService", () => {
  it("normalizes names, verifies every member and freezes a sorted member list", async () => {
    const create = vi.fn(async (input) => ({
      ...input,
      revision: 1,
      createdAt: input.recordedAt,
      updatedAt: input.recordedAt,
    }));
    const getRunner = vi.fn(async (runnerId: string) => runnerRecord(runnerId));
    const service = serviceWith({ create }, { get: getRunner });

    await service.create({
      name: "  华东执行池  ",
      description: "上海机房",
      runnerIds: ["runner-b", "runner-a"],
    });

    expect(getRunner).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith({
      id: "group-1",
      name: "华东执行池",
      normalizedName: "华东执行池",
      description: "上海机房",
      runnerIds: ["runner-a", "runner-b"],
      recordedAt: now.toISOString(),
    });
  });

  it("rejects missing or purged members before writing the group", async () => {
    const create = vi.fn();
    const service = serviceWith(
      { create },
      {
        get: vi.fn(async (runnerId: string) =>
          runnerId === "runner-purged"
            ? runnerRecord(runnerId, { purgedAt: now.toISOString() })
            : null,
        ),
      },
    );

    await expect(
      service.create({ name: "不可用资源池", runnerIds: ["runner-purged"] }),
    ).rejects.toMatchObject({ code: "RUNNER_NOT_FOUND" });
    expect(create).not.toHaveBeenCalled();
  });

  it("uses optimistic revisions and reports stale updates", async () => {
    const groups = {
      get: vi.fn().mockResolvedValue({ id: "group-1", revision: 3 }),
      update: vi.fn().mockResolvedValue(null),
    };
    const service = serviceWith(groups);

    await expect(
      service.update("group-1", {
        name: "更新后的资源池",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "RUNNER_GROUP_REVISION_CONFLICT" });
    expect(groups.update).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "group-1",
        expectedRevision: 2,
        normalizedName: "更新后的资源池",
      }),
    );
  });

  it("maps normalized-name constraint failures to a stable domain error", async () => {
    const service = serviceWith({
      create: vi.fn().mockRejectedValue(new Error("runner_groups_normalized_name_uq")),
    });

    await expect(service.create({ name: "重复组", runnerIds: [] })).rejects.toMatchObject({
      code: "RUNNER_GROUP_NAME_CONFLICT",
    });
  });
});

function runnerRecord(runnerId: string, overrides: Partial<Runner> = {}): Runner {
  return {
    id: runnerId,
    name: runnerId,
    state: "online",
    os: "linux",
    architecture: "amd64",
    agentVersion: "0.7.2",
    protocolVersion: 1,
    labels: ["java", "testng"],
    capabilities: ["executor:testng-v1", "java:21.0.8", "testng:7.11.0"],
    maxConcurrency: 2,
    busySlots: 0,
    lastSeenAt: now.toISOString(),
    terminalEnabled: false,
    credentialVersion: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}
