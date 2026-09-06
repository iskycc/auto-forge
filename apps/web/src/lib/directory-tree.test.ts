import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearBrowserSnapshots } from "./browser-read-cache";
import { readLazyDirectoryBranch } from "./directory-tree";
import type { DirectoryProjection } from "./directory-projection";

const projection: DirectoryProjection = {
  status: {
    id: "a".repeat(64),
    generation: "00000000-0000-4000-8000-000000000001",
    state: "ready",
    generatedAt: "2026-09-07T00:00:00.000Z",
  },
  manifest: { caseCount: 100_000, partCount: 1000, rootOrdinal: 2001 },
};
const branch = {
  directories: [
    { name: "closed", path: "closed", caseCount: 100_000, ordinal: 2000, kind: "case" },
  ],
  items: [],
  outcomes: [],
  members: { items: [], ddtItems: [] },
  nextOrdinal: null,
};
describe("lazy directory reads", () => {
  beforeEach(clearBrowserSnapshots);
  it("reads only the requested branch and reuses it without fetching unopened descendants", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(branch));
    const input = { projection, ordinal: 2001, signal: new AbortController().signal, fetcher };
    expect((await readLazyDirectoryBranch(input)).directories).toHaveLength(1);
    await readLazyDirectoryBranch(input);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain("ordinal=2001");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("ordinal=2000"))).toBe(false);
  });
  it("does not cache a response when the folder closes during its request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return Response.json(branch);
    });
    await expect(
      readLazyDirectoryBranch({ projection, ordinal: 2001, signal: controller.signal, fetcher }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const retry = vi.fn<typeof fetch>(async () => Response.json(branch));
    await readLazyDirectoryBranch({
      projection,
      ordinal: 2001,
      signal: new AbortController().signal,
      fetcher: retry,
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("reports a generation conflict without traversing or combining the replacement tree", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}, { status: 409 }));
    await expect(
      readLazyDirectoryBranch({
        projection,
        ordinal: 2001,
        signal: new AbortController().signal,
        fetcher,
      }),
    ).rejects.toMatchObject({ name: "DirectoryGenerationConflict" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("cannot refill a previous user's cache after the authentication scope changes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      clearBrowserSnapshots();
      return Response.json(branch);
    });
    const input = { projection, ordinal: 2001, signal: new AbortController().signal, fetcher };
    await readLazyDirectoryBranch(input);
    await readLazyDirectoryBranch(input);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
