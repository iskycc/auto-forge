import { describe, expect, it, vi } from "vitest";
import { RuntimeNotificationService, type RuntimeIncident } from "../src/runtime-notifications";
import type { IdentityAccessRepository, PlatformOperationsRepository } from "../src/ports";

describe("platform protection notifications", () => {
  it("only notifies active system managers, and retries delivery with stable IDs", async () => {
    const incident: RuntimeIncident = {
      id: "incident",
      kind: "log_io",
      createdAt: "2026-09-07T00:00:00.000Z",
    };
    const source = { pendingIncident: () => incident, acknowledgeIncident: vi.fn() };
    const identities = {
      listRoles: async () => [
        { id: "admin", active: true, permissions: ["settings.manage"] },
        { id: "reader", active: true, permissions: ["settings.read"] },
        { id: "disabled-role", active: false, permissions: ["settings.manage"] },
      ],
      listSystemRoleBindings: vi.fn(async () => [
        { userId: "a", roleId: "admin" },
        { userId: "b", roleId: "reader" },
        { userId: "c", roleId: "admin" },
        { userId: "d", roleId: "disabled-role" },
        { userId: "e", roleId: "admin" },
      ]),
      findUser: async (id: string) => ({ id, status: id === "c" ? "disabled" : "active" }),
    } as unknown as IdentityAccessRepository;
    let fail = true;
    const delivered = new Map<string, { userId: string; message: string }>();
    const createNotification = vi.fn(
      async (record: Parameters<PlatformOperationsRepository["createNotification"]>[0]) => {
        if (record.userId === "e" && fail) {
          fail = false;
          throw new Error("database unavailable");
        }
        delivered.set(record.id, record);
        return record;
      },
    );
    const service = new RuntimeNotificationService(
      identities,
      { createNotification },
      source,
      { now: () => new Date(incident.createdAt) },
      "platform-1",
    );
    await expect(service.deliverNextPage()).rejects.toThrow("database unavailable");
    expect(source.acknowledgeIncident).not.toHaveBeenCalled();
    await service.deliverNextPage();
    expect([...delivered.values()].map((notice) => notice.userId)).toEqual(["a", "e"]);
    expect(createNotification.mock.calls[0]?.[0].id).toBe(createNotification.mock.calls[2]?.[0].id);
    expect(source.acknowledgeIncident).toHaveBeenCalledWith("incident");
    expect(identities.listSystemRoleBindings).toHaveBeenCalledWith(undefined, { limit: 50 });
  });
});
