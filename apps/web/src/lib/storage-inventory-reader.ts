import { DomainError } from "@autoforge/domain";
import { storageInventoryPageSchema } from "@autoforge/contracts";
import { z } from "zod";
import type { PlatformNodeRepository } from "@autoforge/application";
import type { StorageInventoryQuery, StorageInventoryService } from "./storage-inventory";

const expiredSnapshotResponseSchema = z.object({
  error: z.object({ code: z.literal("STORAGE_INVENTORY_SNAPSHOT_EXPIRED") }),
});

/** Pin all pages to the node which owns the disposable filesystem index. */
export function createStorageInventoryReader(dependencies: {
  local: Pick<StorageInventoryService, "list">;
  nodeId?: string;
  nodes?: Pick<PlatformNodeRepository, "find">;
  request?: typeof fetch;
}) {
  return async (query: StorageInventoryQuery & { nodeId?: string }, headers: Headers) => {
    if (!query.nodeId || query.nodeId === dependencies.nodeId) {
      return {
        ...(await dependencies.local.list(query)),
        ...(dependencies.nodeId ? { nodeId: dependencies.nodeId } : {}),
      };
    }
    const node = await dependencies.nodes?.find(query.nodeId);
    if (!node?.internalBaseUrl)
      throw new DomainError(
        "READ_MODEL_GENERATION_CONFLICT",
        "存储清单所属平台节点未配置，请检查平台节点地址。",
      );
    const url = new URL("/api/v1/settings/storage", node.internalBaseUrl);
    url.searchParams.set("nodeId", node.id);
    url.searchParams.set("limit", String(query.limit));
    if (query.cursor) url.searchParams.set("cursor", query.cursor);
    if (query.category) url.searchParams.set("category", query.category);
    if (query.query) url.searchParams.set("query", query.query);
    if (query.refresh) url.searchParams.set("refresh", "1");
    // These are registered platform peers sharing the identity store. Re-authorize at the owner;
    // do not forward credentials to redirects or addresses supplied directly by the browser.
    const forwarded = new Headers({ "x-autoforge-storage-hop": "1" });
    for (const name of ["cookie", "authorization"]) {
      const value = headers.get(name);
      if (value) forwarded.set(name, value);
    }
    if (headers.has("x-autoforge-storage-hop"))
      throw new DomainError(
        "READ_MODEL_GENERATION_CONFLICT",
        "存储清单节点地址指向了其他节点，请检查配置。",
      );
    try {
      const response = await (dependencies.request ?? fetch)(url, {
        headers: forwarded,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!response.body) throw new Error(`Storage owner returned HTTP ${response.status}.`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) throw new Error("Storage page exceeds its response limit.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (response.status === 409 && expiredSnapshotResponseSchema.safeParse(payload).success)
        throw new DomainError(
          "STORAGE_INVENTORY_SNAPSHOT_EXPIRED",
          "存储清单快照已过期，请刷新清单后重试。",
        );
      if (!response.ok) throw new Error(`Storage owner returned HTTP ${response.status}.`);
      const page = storageInventoryPageSchema.parse(payload);
      if (page.nodeId !== node.id)
        throw new Error("Storage owner returned a different node identity.");
      return page;
    } catch (cause) {
      if (cause instanceof DomainError && cause.code === "STORAGE_INVENTORY_SNAPSHOT_EXPIRED")
        throw cause;
      throw new DomainError(
        "READ_MODEL_NODE_UNAVAILABLE",
        "存储清单所属平台节点暂不可用，请检查节点地址与服务状态后重试。",
        { cause },
      );
    }
  };
}
