import { describe, expect, it, vi } from "vitest";
import {
  isDirectoryProjectionUsable,
  readDirectoryProjection,
  type DirectoryProjection,
} from "./directory-projection";

const published: DirectoryProjection = {
  status: {
    id: "a".repeat(64),
    generation: "generation",
    generatedAt: "2026-10-29T00:00:00.000Z",
    state: "stale",
  },
  manifest: { partCount: 1, caseCount: 1, rootOrdinal: 1 },
  synchronized: false,
};
describe("directory availability during execution", () => {
  it("bounds a pending directory request without cancelling the whole page", async () => {
    const page = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const send = vi.fn<typeof fetch>(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
            once: true,
          });
        }),
    );
    try {
      const pending = readDirectoryProjection("snapshot", "", page.signal, send);
      const failed = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      deadline.abort(new DOMException("directory deadline", "TimeoutError"));
      await failed;
      expect(page.signal.aborted).toBe(false);
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally {
      timeout.mockRestore();
    }
  });
  it("keeps a complete published directory readable while its replacement is deferred", () => {
    expect(isDirectoryProjectionUsable(published, { allowPublishedFallback: true })).toBe(true);
    expect(
      isDirectoryProjectionUsable(
        {
          ...published,
          status: { ...published.status, state: "failed" },
        },
        { allowPublishedFallback: true },
      ),
    ).toBe(true);
  });
  it("keeps debug case pickers synchronized unless browsing fallback is explicitly requested", () => {
    expect(isDirectoryProjectionUsable(published)).toBe(false);
  });
  it("still waits for a complete generation on a cold directory", () => {
    expect(isDirectoryProjectionUsable({ ...published, manifest: null })).toBe(false);
    expect(
      isDirectoryProjectionUsable({
        ...published,
        status: { ...published.status, generation: null },
      }),
    ).toBe(false);
  });
  it("does not restore old suite members after an edit, even if the displayed revision is sufficient", () => {
    const suite = { ...published, manifest: { ...published.manifest!, revision: 3 } };
    expect(
      isDirectoryProjectionUsable(suite, { minimumRevision: 3, allowPublishedFallback: true }),
    ).toBe(false);
    expect(
      isDirectoryProjectionUsable({ ...suite, synchronized: true }, { minimumRevision: 4 }),
    ).toBe(false);
    expect(
      isDirectoryProjectionUsable({ ...suite, synchronized: true }, { minimumRevision: 3 }),
    ).toBe(true);
  });
});
