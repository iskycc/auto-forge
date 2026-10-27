import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCaseSuiteExecutionPolicy, type CaseSuite } from "@autoforge/domain";
import {
  PublicSuiteExecutionService,
  type PublicSuiteExecutionRepository,
} from "../src/public-suite-execution";
import type { PublicSuiteBatch } from "@autoforge/contracts";

const now = "2026-10-27T02:00:00.000Z";
const actor = { id: "visitor", username: "no-project-role", source: "local" as const };
const publisher = { id: "maintainer", username: "task-owner", source: "ldap" as const };
const key = "019aa000-0000-7000-8000-000000000001";
const suite: CaseSuite = {
  id: "suite",
  projectId: "project",
  name: "Wallet 回归",
  description: "真实任务说明",
  version: 1,
  revision: 2,
  status: "active",
  enabled: true,
  policy: { ...defaultCaseSuiteExecutionPolicy, projectVersionId: "version" },
  caseCount: 2000,
  createdAt: now,
  updatedAt: now,
};

function fixture() {
  const links = {
    publish: vi.fn(),
    revoke: vi.fn(),
    publisher: vi.fn().mockResolvedValue(publisher),
    executions: vi.fn().mockResolvedValue({ active: [], recent: [] }),
    batch: vi.fn(),
    replay: vi.fn().mockResolvedValue(null),
  } satisfies PublicSuiteExecutionRepository;
  const getSummary = vi.fn().mockResolvedValue(suite);
  const runs = {
    create: vi.fn().mockResolvedValue({ id: "batch" }),
    getSummary: vi.fn().mockResolvedValue({ id: "batch" }),
  };
  const control = { terminateBatch: vi.fn().mockResolvedValue(2) };
  const publicAccess = { publishBatch: vi.fn().mockResolvedValue("/Execution?BatchId=batch") };
  const service = new PublicSuiteExecutionService(
    links,
    { getSummary },
    { listProjects: vi.fn().mockResolvedValue([{ id: "project", name: "支付平台" }]) },
    { list: vi.fn().mockResolvedValue({ versions: [{ id: "version", name: "V2026" }] }) },
    runs,
    control,
    publicAccess,
    { now: () => new Date(now) },
  );
  return { links, getSummary, runs, control, publicAccess, service };
}

describe("public task execution", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  it("publishes and revokes a per-publisher business link without changing task configuration", async () => {
    await expect(f.service.publish("suite", "maintainer")).resolves.toBe(
      "/RunTask?SuiteId=suite&PublisherId=maintainer",
    );
    expect(f.links.publish).toHaveBeenCalledWith("suite", "maintainer", now);
    await f.service.revoke("suite", "maintainer");
    expect(f.links.revoke).toHaveBeenCalledWith("suite", "maintainer", now);
  });
  it("rejects publication for a disabled task", async () => {
    f.getSummary.mockResolvedValue({ ...suite, enabled: false });
    await expect(f.service.publish("suite", "maintainer")).rejects.toMatchObject({
      code: "CASE_SUITE_DISABLED",
    });
    expect(f.links.publish).not.toHaveBeenCalled();
  });
  it("allows a visitor through the published grant and preserves the saved task settings", async () => {
    await expect(
      f.service.start("suite", "maintainer", { requestKey: key, delaySeconds: 60 }, actor),
    ).resolves.toEqual({ batchId: "batch", progressPath: "/Execution?BatchId=batch" });
    expect(f.runs.create).toHaveBeenCalledWith(
      { suiteId: "suite", delaySeconds: 60 },
      { username: actor.username, source: "local" },
      { publisher, initiator: actor, requestKey: key },
    );
  });
  it("replays the same request even after the execution ended", async () => {
    f.links.replay.mockResolvedValue("batch");
    await f.service.start("suite", "maintainer", { requestKey: key }, actor);
    expect(f.runs.getSummary).toHaveBeenCalledWith("batch");
    expect(f.runs.create).not.toHaveBeenCalled();
  });
  it("rejects missing/revoked grants before reading task or creating executions", async () => {
    f.links.publisher.mockResolvedValue(null);
    await expect(
      f.service.start("suite", "maintainer", { requestKey: key }, actor),
    ).rejects.toMatchObject({ code: "PUBLIC_SUITE_LINK_NOT_FOUND" });
    await expect(f.service.read("suite", "maintainer")).rejects.toMatchObject({
      code: "PUBLIC_SUITE_LINK_NOT_FOUND",
    });
    expect(f.runs.create).not.toHaveBeenCalled();
    expect(f.getSummary).not.toHaveBeenCalled();
  });
  it("only exposes the basic task projection, not Runner credentials, runtime assets or recovery secrets", async () => {
    const view = await f.service.read("suite", "maintainer");
    expect(view).toMatchObject({
      name: suite.name,
      caseCount: 2000,
      projectName: "支付平台",
      versionName: "V2026",
      publisher,
      executable: true,
    });
    expect(view).not.toHaveProperty("policy");
    expect(view).not.toHaveProperty("items");
    expect(view).not.toHaveProperty("runnerIds");
  });
  it("displays a disabled task without offering execution", async () => {
    f.getSummary.mockResolvedValue({ ...suite, enabled: false });
    expect(await f.service.read("suite", "maintainer")).toMatchObject({
      executable: false,
      unavailableReason: expect.any(String),
    });
  });
  it.each([null, { publicExecution: false }])(
    "does not allow the grant to terminate ordinary or unrelated executions: %j",
    async (batch) => {
      f.links.batch.mockResolvedValue(batch);
      await expect(
        f.service.terminate("suite", "maintainer", "other", actor),
      ).rejects.toMatchObject({ code: "RUN_BATCH_NOT_FOUND" });
      expect(f.control.terminateBatch).not.toHaveBeenCalled();
    },
  );
  it("records the actual terminator using the existing authoritative cancellation flow", async () => {
    f.links.batch.mockResolvedValue({ publicExecution: true } as PublicSuiteBatch);
    await expect(f.service.terminate("suite", "maintainer", "batch", actor)).resolves.toBe(2);
    expect(f.control.terminateBatch).toHaveBeenCalledWith(
      actor.id,
      "batch",
      "从任务公开执行页终止",
      actor,
    );
  });
});
