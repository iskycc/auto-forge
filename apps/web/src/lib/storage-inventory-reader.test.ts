import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { StorageInventoryPage } from "@autoforge/contracts";
import { createStorageInventoryReader } from "./storage-inventory-reader";

function fixture() {
  const nodeId = randomUUID();
  const ownerId = randomUUID();
  const page: StorageInventoryPage = {
    items: [],
    snapshotState: "ready",
    generation: randomUUID(),
    nodeId: ownerId,
    summary: {
      generatedAt: "2026-09-05T00:00:00.000Z",
      dataDirectory: "/data",
      objectStore: "local",
      objectStoreRoot: "/data/objects",
      fileCount: 0,
      logicalBytes: 0,
      allocatedBytes: 0,
      externalReferenceCount: 0,
      externalReferenceBytes: 0,
      categories: [],
    },
  };
  const local = { list: vi.fn(async () => page) };
  const nodes = {
    find: vi.fn(async () => ({
      id: ownerId,
      name: "owner",
      internalBaseUrl: "http://192.0.2.10:3000",
      revision: 1,
      createdAt: page.summary.generatedAt,
      updatedAt: page.summary.generatedAt,
    })),
  };
  const request = vi.fn<typeof fetch>(async () => Response.json(page));
  return {
    nodeId,
    ownerId,
    page,
    local,
    nodes,
    request,
    read: createStorageInventoryReader({ nodeId, local, nodes, request }),
  };
}

it("uses the local inventory without probing another node in Lite or on the owner", async () => {
  const test = fixture();
  expect((await test.read({ limit: 50 }, new Headers())).nodeId).toBe(test.nodeId);
  expect((await test.read({ limit: 50, nodeId: test.nodeId }, new Headers())).nodeId).toBe(
    test.nodeId,
  );
  expect(test.request).not.toHaveBeenCalled();
  expect(test.nodes.find).not.toHaveBeenCalled();
});

it("pins pagination to a registered owner and forwards only authentication headers without redirects", async () => {
  const test = fixture();
  const cursor = `${test.page.generation}:49`;
  expect(
    await test.read(
      { nodeId: test.ownerId, cursor, limit: 50 },
      new Headers({ cookie: "fixture-session", host: "untrusted.invalid" }),
    ),
  ).toEqual(test.page);
  expect(test.local.list).not.toHaveBeenCalled();
  const [url, options] = test.request.mock.calls[0]!;
  expect(new URL(String(url)).origin).toBe("http://192.0.2.10:3000");
  expect(new URL(String(url)).searchParams.get("cursor")).toBe(cursor);
  expect(options?.redirect).toBe("error");
  expect(new Headers(options?.headers).get("host")).toBeNull();
  expect(new Headers(options?.headers).get("cookie")).toBe("fixture-session");
});

it("rejects routing loops, missing owners and mismatched responses without mixing local files", async () => {
  const test = fixture();
  await expect(
    test.read({ limit: 50, nodeId: test.ownerId }, new Headers({ "x-autoforge-storage-hop": "1" })),
  ).rejects.toMatchObject({ code: "READ_MODEL_GENERATION_CONFLICT" });
  test.request.mockResolvedValueOnce(Response.json({ ...test.page, nodeId: test.nodeId }));
  await expect(test.read({ limit: 50, nodeId: test.ownerId }, new Headers())).rejects.toMatchObject(
    { code: "READ_MODEL_NODE_UNAVAILABLE" },
  );
  test.request.mockRejectedValueOnce(new Error("unreachable"));
  await expect(test.read({ limit: 50, nodeId: test.ownerId }, new Headers())).rejects.toMatchObject(
    { code: "READ_MODEL_NODE_UNAVAILABLE" },
  );
  expect(test.local.list).not.toHaveBeenCalled();
  const noPeers = createStorageInventoryReader({ nodeId: test.nodeId, local: test.local });
  await expect(noPeers({ limit: 50, nodeId: test.ownerId }, new Headers())).rejects.toMatchObject({
    code: "READ_MODEL_GENERATION_CONFLICT",
  });
});
