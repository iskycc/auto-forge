import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@autoforge/domain";
import { securityAuditActions } from "@autoforge/contracts";
import { auditCsv, presentAuditEvent } from "./audit-presentation";

const historicalDenial: AuditEvent = {
  id: "event-id",
  actorType: "user",
  actorId: "user-id",
  action: "auth.access_denied",
  resourceType: "access_control",
  projectId: "project-a",
  result: "rejected",
  requestId: "request-id",
  details: { permission: "case.manage" },
  recordedAt: "2026-09-07T00:00:00.000Z",
};

describe("Chinese security audit presentation", () => {
  it("describes historical events and permissions without exposing internal codes", () => {
    const item = presentAuditEvent(historicalDenial, {
      users: new Map([["user-id", "测试人员"]]),
      projects: new Map([["project-a", "支付项目"]]),
    });
    expect(item).toMatchObject({
      action: "越权访问被拒绝",
      actor: "测试人员",
      resource: "访问权限",
      project: "支付项目",
      resultLabel: "已拒绝",
    });
    expect(item.details).toContainEqual({ label: "请求的权限", value: "管理用例" });
    expect(JSON.stringify(item)).not.toMatch(/auth\.access_denied|case\.manage/u);
  });

  it("gives every admitted event a Chinese description and category", () => {
    for (const entry of securityAuditActions) {
      const item = presentAuditEvent({ ...historicalDenial, action: entry.action });
      expect(item.action).toMatch(/[\u4e00-\u9fff]/u);
      expect(item.category).toMatch(/[\u4e00-\u9fff]/u);
      expect(item.action).not.toBe(entry.action);
    }
  });

  it("uses snapshots for renamed or removed actors and Chinese fallbacks for future fields", () => {
    const item = presentAuditEvent({
      ...historicalDenial,
      action: "future.action",
      details: {
        actorName: "操作时的姓名",
        permission: "future.permission",
        reasonCode: "UNKNOWN_CODE",
        enabled: true,
      },
    });
    expect(item.actor).toBe("操作时的姓名");
    expect(item.action).toBe("历史安全事件");
    expect(JSON.stringify(item)).not.toMatch(/future\.|UNKNOWN_CODE/u);
    expect(item.details).toContainEqual({ label: "已启用", value: "是" });
  });

  it("preserves user names and free text even when they match internal enum values", () => {
    const item = presentAuditEvent({
      ...historicalDenial,
      details: { name: "system", fileName: "local", category: "audit" },
    });
    expect(item.details).toContainEqual({ label: "名称", value: "system" });
    expect(item.details).toContainEqual({ label: "文件名称", value: "local" });
    expect(item.details).toContainEqual({ label: "数据类别", value: "安全审计" });
  });

  it("exports Chinese headers, descriptions and detail names with safe spreadsheet cells", () => {
    const csv = auditCsv([
      {
        ...historicalDenial,
        details: { ...historicalDenial.details, actorName: '=HYPERLINK("bad")' },
      },
    ]);
    expect(csv).toContain('"操作描述"');
    expect(csv).toContain('"越权访问被拒绝"');
    expect(csv).toContain("请求的权限：管理用例");
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).not.toMatch(/auth\.access_denied|case\.manage|permission/u);
    expect(csv.startsWith("\uFEFF")).toBe(true);
  });
});
