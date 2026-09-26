import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeArchiveCache } from "../src/runtime-archive-cache";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "autoforge-runtime-cache-"));
  directories.push(dataDirectory);
  const content = Buffer.from("complete bundle fixture");
  const archive = {
    url: "http://private-artifacts.example/runtime.zip",
    sizeBytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  let now = Date.now();
  const fetchArchive = vi.fn<typeof fetch>(async () => new Response(content));
  const create = () =>
    new RuntimeArchiveCache({ dataDirectory, now: () => now, fetch: fetchArchive });
  const consume = async (cache: RuntimeArchiveCache, input = archive) => {
    const opened = await cache.open(input, new AbortController().signal);
    return Buffer.concat(await Readable.from(opened.content).toArray());
  };
  return {
    archive,
    content,
    create,
    consume,
    fetchArchive,
    dataDirectory,
    advance: (hours: number) => {
      now += hours * 3_600_000;
    },
  };
}

describe("platform runtime archive cache", () => {
  it("streams an actual HTTP source without credentials and rejects redirects", async () => {
    const test = await fixture();
    const requests: Array<{ path?: string; authorization?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        ...(request.url ? { path: request.url } : {}),
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      });
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "/archive" });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Length": test.content.length });
      response.end(test.content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test HTTP address");
      const base = `http://127.0.0.1:${address.port}`;
      const cache = new RuntimeArchiveCache({
        dataDirectory: test.dataDirectory,
        now: Date.now,
        fetch,
      });
      const redirected = { ...test.archive, url: `${base}/redirect` };
      await expect(test.consume(cache, redirected)).rejects.toThrow();
      expect(requests).toEqual([{ path: "/redirect" }]);
      const archive = { ...test.archive, url: `${base}/archive` };
      expect(await test.consume(cache, archive)).toEqual(test.content);
      expect(await test.consume(cache, archive)).toEqual(test.content);
      expect(requests).toEqual([{ path: "/redirect" }, { path: "/archive" }]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("shares concurrent downloads and survives restart with sliding expiry", async () => {
    const test = await fixture();
    const cache = test.create();
    expect(await Promise.all(Array.from({ length: 8 }, () => test.consume(cache)))).toEqual(
      Array.from({ length: 8 }, () => test.content),
    );
    expect(test.fetchArchive).toHaveBeenCalledTimes(1);
    test.advance(23);
    expect(await test.consume(test.create())).toEqual(test.content);
    test.advance(23);
    expect(await test.consume(test.create())).toEqual(test.content);
    expect(test.fetchArchive).toHaveBeenCalledTimes(1);
    test.advance(24);
    await test.consume(test.create());
    expect(test.fetchArchive).toHaveBeenCalledTimes(2);
    expect(test.fetchArchive).toHaveBeenCalledWith(
      test.archive.url,
      expect.objectContaining({
        redirect: "error",
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": "AutoForge-Control-Plane",
        },
      }),
    );
  });

  it("rejects digest and size mismatches without publishing a partial archive", async () => {
    const test = await fixture();
    const cache = test.create();
    test.fetchArchive.mockImplementationOnce(async () => new Response("bad"));
    await expect(test.consume(cache)).rejects.toThrow("SHA-256");
    expect(await readdir(join(test.dataDirectory, "cache/runtime-archives/v1"))).toEqual([]);
    expect(await test.consume(cache)).toEqual(test.content);
    await writeFile(
      join(
        test.dataDirectory,
        "cache/runtime-archives/v1",
        `${test.archive.sha256}-${test.archive.sizeBytes}`,
      ),
      "corrupted",
    );
    expect(await test.consume(cache)).toEqual(test.content);
    expect(test.fetchArchive).toHaveBeenCalledTimes(3);
  });

  it("does not let one disconnected Agent cancel a shared download", async () => {
    const test = await fixture();
    let finish!: () => void;
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    test.fetchArchive.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return new Response(test.content);
    });
    const cache = test.create();
    const controller = new AbortController();
    const disconnected = cache.open(test.archive, controller.signal);
    const rejection = expect(disconnected).rejects.toMatchObject({ name: "AbortError" });
    await downloading;
    const remaining = test.consume(cache);
    controller.abort();
    finish();
    await rejection;
    expect(await remaining).toEqual(test.content);
    expect(test.fetchArchive).toHaveBeenCalledTimes(1);
  });

  it("closes a cancelled output stream and leaves the validated cache reusable", async () => {
    const test = await fixture();
    const cache = test.create();
    const controller = new AbortController();
    const opened = await cache.open(test.archive, controller.signal);
    controller.abort();
    await expect(Readable.from(opened.content).toArray()).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await test.consume(cache)).toEqual(test.content);
    expect(test.fetchArchive).toHaveBeenCalledTimes(1);
  });

  it("keeps a changed bundle separate and does not reuse a stale URL response", async () => {
    const test = await fixture();
    const cache = test.create();
    await test.consume(cache);
    const newer = Buffer.from("new complete bundle");
    test.fetchArchive.mockImplementationOnce(async () => new Response(newer));
    const metadata = {
      ...test.archive,
      sizeBytes: newer.length,
      sha256: createHash("sha256").update(newer).digest("hex"),
    };
    expect(await test.consume(cache, metadata)).toEqual(newer);
    expect(test.fetchArchive).toHaveBeenCalledTimes(2);
  });
});
