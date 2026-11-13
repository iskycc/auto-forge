import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCaseSuiteExecutionPolicy, type CaseSuite } from "@autoforge/domain";
import {
  PublicSuiteExecutionService,
  type PublicSuiteExecutionRepository,
} from "../src/public-suite-execution";

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
    environment: vi.fn().mockResolvedValue({ revision: 0, change: null }),
    changeEnvironment: vi.fn(),
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
  const control = {
    changeBatchScheduling: vi.fn().mockResolvedValue(true),
    terminateBatch: vi.fn().mockResolvedValue(2),
  };
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
  it("shares the latest IP and modifier between visitors without changing a locked task", async () => {
    const change = { addresses: ["10.0.0.21"], modifiedBy: actor, modifiedAt: now };
    const environment = { revision: 1, change };
    f.getSummary.mockResolvedValue({
      ...suite,
      lockedBy: publisher.id,
      policy: {
        ...suite.policy,
        adapter: { ...suite.policy.adapter, enabled: true, environmentAddresses: ["10.0.0.11"] },
      },
    });
    f.links.changeEnvironment.mockResolvedValue(environment);
    await expect(
      f.service.changeEnvironment(
        "suite",
        publisher.id,
        { revision: 0, addresses: change.addresses },
        actor,
      ),
    ).resolves.toEqual(environment);
    expect(f.links.changeEnvironment).toHaveBeenCalledWith(
      "suite",
      publisher.id,
      { revision: 0, addresses: change.addresses },
      actor,
      now,
    );
    f.links.environment.mockResolvedValue(environment);
    expect(await f.service.read("suite", publisher.id)).toMatchObject({
      environment,
      environmentAddresses: ["10.0.0.11"],
    });
    await f.service.start(
      "suite",
      publisher.id,
      { requestKey: key, environmentRevision: 1 },
      publisher,
    );
    expect(f.runs.create).toHaveBeenLastCalledWith(
      { suiteId: "suite", delaySeconds: 0 },
      { username: publisher.username, source: publisher.source },
      {
        publisher,
        initiator: publisher,
        requestKey: key,
        environmentAddresses: change.addresses,
        environmentRevision: 1,
        environmentChange: change,
      },
    );
    await expect(
      f.service.start("suite", publisher.id, { requestKey: key, environmentRevision: 0 }, actor),
    ).rejects.toMatchObject({ code: "PUBLIC_SUITE_ENVIRONMENT_REVISION_CONFLICT" });
    expect(f.runs.create).toHaveBeenCalledTimes(1);
    expect(suite.policy.adapter.environmentAddresses).toEqual([]);
  });
  it("does not apply a previous shared override after the task disables Adapter", async () => {
    f.links.environment.mockResolvedValue({
      revision: 1,
      change: { addresses: ["10.0.0.21"], modifiedBy: actor, modifiedAt: now },
    });
    await f.service.start(
      "suite",
      publisher.id,
      { requestKey: key, environmentRevision: 1 },
      actor,
    );
    expect(f.runs.create.mock.calls[0]?.[2]).toMatchObject({
      environmentRevision: 1,
      environmentChange: null,
    });
    expect(f.runs.create.mock.calls[0]?.[2]).not.toHaveProperty("environmentAddresses");
  });
  it("replays an accepted request even when the shared environment changed afterwards", async () => {
    f.links.replay.mockResolvedValue("batch");
    await f.service.start(
      "suite",
      publisher.id,
      { requestKey: key, environmentRevision: 0 },
      actor,
    );
    expect(f.runs.getSummary).toHaveBeenCalledWith("batch");
    expect(f.links.environment).not.toHaveBeenCalled();
  });
  it.each([
    { enabled: false },
    { status: "archived" },
    { policy: { ...suite.policy, adapter: { ...suite.policy.adapter, enabled: false } } },
  ])("rejects edits when task execution is unavailable: %j", async (override) => {
    f.getSummary.mockResolvedValue({ ...suite, ...override });
    await expect(
      f.service.changeEnvironment(
        "suite",
        publisher.id,
        { revision: 0, addresses: ["10.0.0.21"] },
        actor,
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/CASE_SUITE_DISABLED|RUN_BATCH_PREFLIGHT_FAILED/),
    });
    expect(f.links.changeEnvironment).not.toHaveBeenCalled();
  });
  it("publishes and revokes a per-publisher business link without changing task configuration", async () => {
    await expect(f.service.publish("suite", "maintainer")).resolves.toBe(
      "/RunTask?SuiteId=suite&PublisherId=maintainer",
    );
    expect(f.links.publish).toHaveBeenCalledWith("suite", "maintainer", now);
    await f.service.revoke("suite", "maintainer");
    expect(f.links.revoke).toHaveBeenCalledWith("suite", "maintainer", now);
  });
  it("uses the published grant to pause and resume only batches created through that grant", async () => {
    f.links.batch.mockResolvedValue({ publicExecution: true });
    await f.service.changeScheduling("suite", "maintainer", "batch", actor, "pause");
    expect(f.control.changeBatchScheduling).toHaveBeenCalledWith(actor.id, "batch", "pause");
    f.links.batch.mockResolvedValue({ publicExecution: false });
    await expect(
      f.service.changeScheduling("suite", "maintainer", "private-batch", actor, "resume"),
    ).rejects.toMatchObject({ code: "RUN_BATCH_NOT_FOUND" });
    expect(f.control.changeBatchScheduling).toHaveBeenCalledTimes(1);
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
      {
        publisher,
        initiator: actor,
        requestKey: key,
        environmentRevision: 0,
        environmentChange: null,
      },
    );
  });
  it("replays the same request even after the execution ended", async () => {
    f.links.replay.mockResolvedValue("batch");
    await f.service.start("suite", "maintainer", { requestKey: key }, actor);
    expect(f.runs.getSummary).toHaveBeenCalledWith("batch");
    expect(f.runs.create).not.toHaveBeenCalled();
  });
  it("keeps a locked task executable for other users and allows one-time IP selection", async () => {
    f.getSummary.mockResolvedValue({
      ...suite,
      lockedBy: publisher.id,
      lockedByName: publisher.username,
      policy: {
        ...suite.policy,
        adapter: { ...suite.policy.adapter, enabled: true, environmentAddresses: ["10.0.0.11"] },
      },
    });
    expect(await f.service.read("suite", publisher.id)).toMatchObject({
      executable: true,
      environmentAddresses: ["10.0.0.11"],
    });
    for (const delaySeconds of [0, 120]) {
      await f.service.start(
        "suite",
        publisher.id,
        { requestKey: key, delaySeconds, environmentAddresses: ["10.0.0.21"] },
        actor,
      );
      expect(f.runs.create).toHaveBeenLastCalledWith(
        { suiteId: "suite", delaySeconds },
        { username: actor.username, source: actor.source },
        { publisher, initiator: actor, requestKey: key, environmentAddresses: ["10.0.0.21"] },
      );
    }
    expect(await f.service.read("suite", publisher.id)).toMatchObject({
      environmentAddresses: ["10.0.0.11"],
    });
  });
  it("passes one-time environment addresses into the authorized execution context", async () => {
    const environmentAddresses = ["10.0.0.21", "2001:db8::21"];
    await f.service.start(
      "suite",
      "maintainer",
      { requestKey: key, delaySeconds: 120, environmentAddresses },
      actor,
    );
    expect(f.runs.create).toHaveBeenCalledWith(
      { suiteId: "suite", delaySeconds: 120 },
      { username: actor.username, source: actor.source },
      { publisher, initiator: actor, requestKey: key, environmentAddresses },
    );
    await f.service.start("suite", "maintainer", { requestKey: key }, actor);
    expect(f.runs.create.mock.calls[1]?.[2]).not.toHaveProperty("environmentAddresses");
  });
  it("shows all saved environment addresses without returning the full policy", async () => {
    f.getSummary.mockResolvedValue({
      ...suite,
      policy: {
        ...suite.policy,
        adapter: {
          ...suite.policy.adapter,
          enabled: true,
          environmentAddresses: ["10.0.0.11", "2001:db8::11"],
        },
      },
    });
    expect(await f.service.read("suite", "maintainer")).toMatchObject({
      adapterEnabled: true,
      environmentAddresses: ["10.0.0.11", "2001:db8::11"],
    });
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
  it("requires another user, including the publisher, to type the initiator and the complete batch IP pool", async () => {
    f.links.batch.mockResolvedValue({
      publicExecution: true,
      initiator: actor,
      requestedBy: actor.username,
      environmentAddresses: ["10.0.0.21", "2001:db8::21"],
    });
    await expect(
      f.service.terminate("suite", publisher.id, "batch", publisher),
    ).rejects.toMatchObject({ code: "PUBLIC_SUITE_TERMINATION_CONFIRMATION_REQUIRED" });
    for (const confirmation of [
      { initiatorUsername: "wrong-user", environmentAddresses: ["10.0.0.21", "2001:db8::21"] },
      { initiatorUsername: actor.username, environmentAddresses: ["10.0.0.21"] },
      { initiatorUsername: actor.username, environmentAddresses: ["10.0.0.21", "10.0.0.99"] },
      {
        initiatorUsername: actor.username,
        environmentAddresses: ["10.0.0.21", "2001:db8::21", "10.0.0.99"],
      },
    ])
      await expect(
        f.service.terminate("suite", publisher.id, "batch", publisher, confirmation),
      ).rejects.toMatchObject({ code: "PUBLIC_SUITE_TERMINATION_CONFIRMATION_MISMATCH" });
    expect(f.control.terminateBatch).not.toHaveBeenCalled();
    await expect(
      f.service.terminate("suite", publisher.id, "batch", publisher, {
        initiatorUsername: actor.username,
        environmentAddresses: ["2001:0db8:0:0:0:0:0:21", " 10.0.0.21 "],
      }),
    ).resolves.toBe(2);
    expect(f.control.terminateBatch).toHaveBeenCalledWith(
      publisher.id,
      "batch",
      "从任务公开执行页终止",
      publisher,
    );
  });
  it("compares immutable actor IDs and explicitly confirms a batch without an environment", async () => {
    f.links.batch.mockResolvedValue({
      publicExecution: true,
      initiator: { ...actor, id: "different-user" },
      requestedBy: actor.username,
      environmentAddresses: [],
    });
    await expect(f.service.terminate("suite", publisher.id, "batch", actor)).rejects.toMatchObject({
      code: "PUBLIC_SUITE_TERMINATION_CONFIRMATION_REQUIRED",
    });
    await expect(
      f.service.terminate("suite", publisher.id, "batch", actor, {
        initiatorUsername: actor.username,
        environmentAddresses: [],
      }),
    ).rejects.toMatchObject({ code: "PUBLIC_SUITE_TERMINATION_CONFIRMATION_MISMATCH" });
    await expect(
      f.service.terminate("suite", publisher.id, "batch", actor, {
        initiatorUsername: actor.username,
        environmentAddresses: [],
        noEnvironmentConfirmation: "未配置环境 IP",
      }),
    ).resolves.toBe(2);
  });
  it("records the actual terminator using the existing authoritative cancellation flow", async () => {
    f.links.batch.mockResolvedValue({
      publicExecution: true,
      initiator: actor,
      environmentAddresses: [],
    });
    await expect(f.service.terminate("suite", "maintainer", "batch", actor)).resolves.toBe(2);
    expect(f.control.terminateBatch).toHaveBeenCalledWith(
      actor.id,
      "batch",
      "从任务公开执行页终止",
      actor,
    );
  });
});
