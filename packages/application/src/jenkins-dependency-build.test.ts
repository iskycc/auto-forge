import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JenkinsDependencyBuild, JenkinsDependencyConnection } from "@autoforge/contracts";
import { JenkinsDependencyBuildService } from "./jenkins-dependency-build";
import type {
  JenkinsDependencyRecord,
  JenkinsDependencyRepository,
} from "./jenkins-dependency-build-ports";

class Repository implements JenkinsDependencyRepository {
  record: JenkinsDependencyRecord | null = null;
  status: "active" | "archived" | null = "active";
  async versionStatus() {
    return this.status;
  }
  async read() {
    return this.record ? structuredClone(this.record) : null;
  }
  async save(input: Parameters<JenkinsDependencyRepository["save"]>[0]) {
    if (
      (this.record?.revision ?? 0) !== input.expectedRevision ||
      (this.record?.build &&
        ["submitting", "queued", "running", "unknown"].includes(this.record.build.status))
    )
      return false;
    this.record = {
      ...input,
      revision: input.expectedRevision + 1,
      buildRevision: this.record?.buildRevision ?? 0,
      ...(this.record?.build ? { build: this.record.build } : {}),
    };
    return true;
  }
  async claim(input: Parameters<JenkinsDependencyRepository["claim"]>[0]) {
    if (
      !this.record ||
      this.record.revision !== input.expectedRevision ||
      this.record.buildRevision !== input.expectedBuildRevision ||
      (this.record.build &&
        ["submitting", "queued", "running", "unknown"].includes(this.record.build.status))
    )
      return false;
    this.record.build = input.build;
    this.record.buildRevision++;
    return true;
  }
  async updateBuild(_version: string, revision: number, build: JenkinsDependencyBuild) {
    if (!this.record || this.record.buildRevision !== revision) return false;
    this.record.build = build;
    this.record.buildRevision++;
    return true;
  }
}

const connection: JenkinsDependencyConnection = {
  jobUrl: "https://jenkins.test/job/dependencies/",
  username: "builder",
  apiToken: "private-token",
  parameters: [{ name: "VERSION", value: "版本 中文&+" }],
};

describe("version dependency pipeline", () => {
  let repository: Repository;
  const transport = { inspect: vi.fn(), trigger: vi.fn(), poll: vi.fn() };
  const cipher = {
    available: true,
    encrypt: (text: string) => `cipher:${text}`,
    decrypt: (text: string) => text.slice(7),
  };
  const now = new Date("2026-11-06T10:00:00Z");
  let service: JenkinsDependencyBuildService;
  beforeEach(() => {
    vi.resetAllMocks();
    repository = new Repository();
    transport.inspect.mockResolvedValue({ name: "dependencies", buildable: true });
    transport.trigger.mockResolvedValue({ queueUrl: "https://jenkins.test/queue/item/7/" });
    transport.poll.mockResolvedValue({
      status: "running",
      buildNumber: 42,
      buildUrl: `${connection.jobUrl}42/`,
    });
    service = new JenkinsDependencyBuildService(repository, transport, cipher, { now: () => now });
  });
  const save = () => service.save("project", "version", { ...connection, expectedRevision: 0 });
  const trigger = () =>
    service.trigger(
      "project",
      "version",
      { requestId: "request-1", expectedRevision: 1, expectedBuildRevision: 0 },
      "operator",
    );

  it("stores the token encrypted and only exposes a configured flag; blank token preserves it", async () => {
    const view = await save();
    expect(JSON.stringify(view)).not.toContain("private-token");
    expect(view.configuration).toMatchObject({ apiTokenConfigured: true });
    expect(repository.record?.connectionCiphertext).toContain("cipher:");
    const publicConnection = {
      jobUrl: connection.jobUrl,
      username: connection.username,
      parameters: connection.parameters,
    };
    await service.save("project", "version", { ...publicConnection, expectedRevision: 1 });
    await service.inspect("project", "version");
    expect(transport.inspect).toHaveBeenCalledWith(connection);
    await expect(
      service.save("project", "version", {
        ...publicConnection,
        jobUrl: "https://other.test/job/x/",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "JENKINS_CREDENTIAL_REQUIRED" });
  });
  it("rejects stale configuration edits without overwriting credentials", async () => {
    await save();
    await expect(
      service.save("project", "version", { ...connection, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "JENKINS_CONFIGURATION_REVISION_CONFLICT" });
    expect(repository.record?.revision).toBe(1);
  });
  it("claims before sending, rejects a second request and replays the same request without rebuilding", async () => {
    await save();
    await trigger();
    await trigger();
    expect(transport.trigger).toHaveBeenCalledTimes(1);
    await expect(
      service.trigger(
        "project",
        "version",
        { requestId: "request-2", expectedRevision: 1, expectedBuildRevision: 0 },
        "other",
      ),
    ).rejects.toMatchObject({ code: "JENKINS_BUILD_CONFLICT" });
    await expect(
      service.save("project", "version", { ...connection, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "JENKINS_BUILD_CONFLICT" });
  });
  it("tracks the exact queue/build and retains the result across reopening", async () => {
    await save();
    const queued = await trigger();
    expect(queued.build?.status).toBe("queued");
    expect(queued.build?.triggeredBy).toBe("operator");
    const running = await service.read("project", "version", true);
    expect(running.build?.buildNumber).toBe(42);
    transport.poll.mockResolvedValue({ status: "succeeded", result: "SUCCESS" });
    expect((await service.read("project", "version", true)).build?.status).toBe("succeeded");
    await service.read("project", "version", true);
    expect(transport.poll).toHaveBeenCalledTimes(2);
  });
  it("does not repeat an uncertain POST and requires explicit acknowledgement", async () => {
    await save();
    transport.trigger.mockRejectedValue(new Error("network timed out private-token"));
    const view = await trigger();
    expect(view.build?.status).toBe("unknown");
    expect(JSON.stringify(view)).not.toContain("private-token");
    await expect(
      service.trigger(
        "project",
        "version",
        { requestId: "request-2", expectedRevision: 1, expectedBuildRevision: view.buildRevision },
        "operator",
      ),
    ).rejects.toMatchObject({ code: "JENKINS_BUILD_CONFLICT" });
    const resolved = await service.acknowledge("project", "version", view.buildRevision);
    expect(resolved.build?.status).toBe("closed");
    expect(transport.trigger).toHaveBeenCalledTimes(1);
  });
  it("recovers interrupted submission conservatively without triggering again", async () => {
    await save();
    await trigger();
    repository.record!.build = {
      ...repository.record!.build!,
      status: "submitting",
      triggeredAt: "2026-11-06T09:00:00Z",
    };
    expect((await service.read("project", "version", true)).build?.status).toBe("unknown");
    expect(transport.trigger).toHaveBeenCalledTimes(1);
  });
  it("keeps known queue state on temporary polling errors, and refuses missing/archived scopes", async () => {
    await save();
    await trigger();
    transport.poll.mockRejectedValue(new Error("unavailable"));
    await expect(service.read("project", "version", true)).rejects.toMatchObject({
      code: "JENKINS_STATUS_UNAVAILABLE",
    });
    expect(repository.record?.build?.status).toBe("queued");
    repository.status = null;
    await expect(service.read("other", "version")).rejects.toMatchObject({
      code: "PROJECT_VERSION_NOT_FOUND",
    });
    repository.status = "archived";
    await expect(trigger()).rejects.toMatchObject({ code: "PROJECT_VERSION_ARCHIVED" });
  });
});
