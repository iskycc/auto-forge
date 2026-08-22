import type { GlobalSearchResult, Notification } from "@autoforge/contracts";
import { describe, expect, it } from "vitest";

import { notificationMessage, searchResultSubtitle } from "./topbar-presentation";

const notification: Notification = {
  id: "notice-id",
  userId: "user-id",
  kind: "batch.completed",
  severity: "warning",
  title: "执行批次已完成",
  message: "每日冒烟测试：failed",
  createdAt: "2026-08-22T00:00:00.000Z",
};

describe("topbar presentation", () => {
  it("localizes persisted batch status codes", () => {
    expect(notificationMessage(notification)).toBe("每日冒烟测试：执行失败");
  });

  it("adds a stable short identifier only for ambiguous results", () => {
    const item: GlobalSearchResult["items"][number] = {
      kind: "run",
      id: "01a001e4-40c6-7959-875c-a3bd4895647b",
      title: "CheckoutTest",
      subtitle: "queued",
      href: "/execution-records",
    };
    expect(searchResultSubtitle(item, false)).toBe("等待资源");
    expect(searchResultSubtitle(item, true)).toBe("等待资源 · 标识 01a001e4");
  });
});
