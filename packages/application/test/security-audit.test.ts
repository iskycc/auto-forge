import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedIdentity } from "@autoforge/domain";
import { IdentityAccessService } from "../src/manage-identity-access";

const administrator: AuthenticatedIdentity = {
  user: {
    id: "administrator",
    username: "admin",
    displayName: "管理员",
    version: 1,
    source: "local",
    status: "active",
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  },
  sessionId: "session",
  systemPermissions: ["audit.read", "audit.export"],
  projectPermissions: {},
};

function fixture() {
  const appendAudit = vi.fn().mockResolvedValue(undefined);
  const listAudit = vi.fn().mockResolvedValue({ items: [] });
  const invalidate = vi.fn().mockResolvedValue(undefined);
  type Dependencies = ConstructorParameters<typeof IdentityAccessService>;
  const service = new IdentityAccessService(
    { appendAudit, listAudit } as unknown as Dependencies[0],
    {} as Dependencies[1],
    {} as Dependencies[2],
    {} as Dependencies[3],
    {} as Dependencies[4],
    { now: () => new Date("2026-09-07T00:00:00.000Z") },
    { next: () => "audit-event" },
    8,
    { invalidate },
  );
  return { service, appendAudit, listAudit, invalidate };
}

describe("security audit scope", () => {
  it("excludes execution, retry and probe activity while preserving page cache invalidation", async () => {
    const { service, appendAudit, invalidate } = fixture();
    for (const action of [
      "run_batch.create",
      "run_attempt.rerun",
      "run_batch.rerun_final_failures",
      "webhook.test",
      "case_source.compare",
      "runner.install.probe",
    ]) {
      await service.recordAuthorizedOperation(administrator, {
        action,
        resourceType: "run_batch",
        projectId: "project-a",
      });
    }
    expect(appendAudit).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledTimes(6);
  });

  it("persists Chinese descriptions and actor names for important changes", async () => {
    const { service, appendAudit } = fixture();
    await service.recordAuthorizedOperation(administrator, {
      action: "case_definition.delete",
      resourceType: "case_definition",
      resourceId: "case-a",
      projectId: "project-a",
      details: { displayName: "支付用例" },
    });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "case_definition.delete",
        details: expect.objectContaining({
          eventDescription: "删除用例",
          actorName: "管理员 · admin",
          displayName: "支付用例",
        }),
      }),
    );
  });

  it("applies the same allowed action set before pagination and export", async () => {
    const { service, listAudit } = fixture();
    await service.listAudit(administrator, { limit: 30 });
    await service.exportAudit(administrator, { maximumEvents: 100 });
    for (const [query] of listAudit.mock.calls) {
      expect(query.actions).toContain("case_definition.update");
      expect(query.actions).toContain("auth.login");
      expect(query.actions).not.toContain("run_attempt.rerun");
      expect(query.actions).not.toContain("ldap.test");
    }
  });
});
