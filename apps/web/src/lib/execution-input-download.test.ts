import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DomainError } from "@autoforge/domain";
import { LocalObjectStore } from "@autoforge/object-store/local";
import { RuntimeArchiveCache } from "@autoforge/object-store/runtime-archive-cache";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ getPlatformServices: vi.fn() }));
vi.mock("@/lib/services", () => mocked);

import { GET } from "../app/api/v1/run-attempts/[attemptId]/inputs/[inputId]/route";

const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("execution input download", () => {
  it("authenticates every URL download while reusing the platform cache", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "autoforge-input-route-"));
    directories.push(dataDirectory);
    const content = Buffer.alloc(128 * 1_024, 42);
    const authorized = {
      kind: "url",
      url: "http://intranet.example/jdk.zip",
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      mediaType: "application/zip",
    };
    const fetchArchive = vi.fn<typeof fetch>(async () => new Response(content));
    const resolveInput = vi.fn().mockResolvedValue(authorized);
    mocked.getPlatformServices.mockResolvedValue({
      runnerRequestLimiter: { allow: async () => true },
      executionControl: { resolveInput },
      runtimeArchiveCache: new RuntimeArchiveCache({
        dataDirectory,
        now: Date.now,
        fetch: fetchArchive,
      }),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await GET(request(), {
        params: Promise.resolve({ attemptId: `attempt-${attempt}`, inputId: "runtime-1" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(content.length));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
    }
    expect(fetchArchive).toHaveBeenCalledTimes(1);
    expect(resolveInput).toHaveBeenCalledTimes(2);
    expect(resolveInput).toHaveBeenCalledWith(
      "runner-1",
      "credential",
      "attempt-1",
      "runtime-1",
      "lease-token",
    );
    resolveInput.mockRejectedValueOnce(new DomainError("ATTEMPT_INPUT_FORBIDDEN", "租约无效。"));
    const rejected = await GET(request(), {
      params: Promise.resolve({ attemptId: "expired", inputId: "runtime-1" }),
    });
    expect(rejected.ok).toBe(false);
    expect(await rejected.json()).toMatchObject({ error: { code: "ATTEMPT_INPUT_FORBIDDEN" } });
    expect(fetchArchive).toHaveBeenCalledTimes(1);
  });

  it("streams uploaded objects without using the whole-file read API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autoforge-input-stream-"));
    directories.push(directory);
    const store = new LocalObjectStore(directory);
    const content = Buffer.alloc(256 * 1_024, 7);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const written = await store.putJar("project-1", sha256, content);
    const read = vi.spyOn(store, "read");
    mocked.getPlatformServices.mockResolvedValue({
      runnerRequestLimiter: { allow: async () => true },
      objectStore: store,
      executionControl: {
        resolveInput: async () => ({
          kind: "object",
          ...written,
          sizeBytes: content.length,
          sha256,
          mediaType: "application/java-archive",
        }),
      },
    });
    const response = await GET(request(), {
      params: Promise.resolve({ attemptId: "attempt-1", inputId: "jar-1" }),
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
    expect(read).not.toHaveBeenCalled();
  });
});

function request() {
  return new Request("http://platform.example/api/v1/run-attempts/attempt-1/inputs/runtime-1", {
    headers: {
      Authorization: "Bearer credential",
      "X-AutoForge-Runner-Id": "runner-1",
      "X-AutoForge-Lease-Token": "lease-token",
    },
  });
}
