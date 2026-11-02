import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  readPostgresStorageCapacity,
  parseNodeExporterCapacity,
} from "./postgres-storage-capacity";
const now = new Date("2026-11-02T00:00:00Z");
const source = { host: "127.0.0.1", port: 9100, tls: false, mountpoint: "/pgdata" };
export function volumeMetrics(mountpoint = "/pgdata", size = "1e6", available = "2e5") {
  const labels = `device="/dev/vdb",fstype="ext4",mountpoint="${mountpoint}"`;
  return `node_filesystem_size_bytes{${labels}} ${size}\nnode_filesystem_avail_bytes{${labels}} ${available}\nnode_filesystem_device_error{${labels}} 0\nnode_scrape_collector_success{collector="filesystem"} 1\n`;
}
describe("Node Exporter volume capacity", () => {
  it("matches the configured filesystem and parses exponent values, excluding unrelated mounts", () => {
    const metrics =
      volumeMetrics().replace('node_scrape_collector_success{collector="filesystem"} 1\n', "") +
      volumeMetrics("/", "9e9", "8e9");
    expect(parseNodeExporterCapacity(metrics, "/pgdata", now)).toMatchObject({
      status: "available",
      capacityBytes: 1000000,
      availableBytes: 200000,
      usedPercent: 80,
      sampledAt: now.toISOString(),
    });
  });
  it.each([
    volumeMetrics("/other"),
    volumeMetrics().replace("} 0", "} 1"),
    volumeMetrics().replace('collector="filesystem"} 1', 'collector="filesystem"} 0'),
    volumeMetrics().replace('avail_bytes{device="/dev/vdb"', 'avail_bytes{device="/dev/vdc"'),
    volumeMetrics("/pgdata", "100", "101"),
    volumeMetrics("/pgdata", "NaN", "10"),
    volumeMetrics("/pgdata", "0", "0"),
    volumeMetrics("/pgdata", "100.5", "0"),
    volumeMetrics() + volumeMetrics(),
  ])("rejects missing, ambiguous, failed or impossible filesystem samples", (metrics) => {
    expect(() => parseNodeExporterCapacity(metrics, "/pgdata", now)).toThrow();
  });
  it("does not contact PostgreSQL or any endpoint before monitoring is configured", async () => {
    const request = vi.fn();
    expect((await readPostgresStorageCapacity(null, now, request)).status).toBe("not_configured");
    expect(request).not.toHaveBeenCalled();
  });
  it("requests only filesystem metrics and never follows redirects", async () => {
    const request = vi.fn(async () => new Response(volumeMetrics()));
    expect((await readPostgresStorageCapacity(source, now, request)).status).toBe("available");
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:9100/metrics?collect%5B%5D=filesystem",
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([401, 403, 500, 503])(
    "reports endpoint status %s without exposing private content",
    async (status) => {
      const sample = await readPostgresStorageCapacity(
        source,
        now,
        async () => new Response("secret-password", { status }),
      );
      expect(sample.status).toBe(
        status === 401 || status === 403 ? "permission_denied" : "unavailable",
      );
      expect(JSON.stringify(sample)).not.toContain("secret-password");
    },
  );
  it("limits response bytes and closes the stream on rejection", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel,
    });
    expect(
      (await readPostgresStorageCapacity(source, now, async () => new Response(body))).status,
    ).toBe("unavailable");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("times out a stalled request and releases the caller", async () => {
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const read = readPostgresStorageCapacity(
        source,
        now,
        async (_, init) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
              once: true,
            }),
          ),
      );
      expect(deadline).toHaveBeenCalledWith(2000);
      controller.abort();
      expect((await read).status).toBe("unavailable");
    } finally {
      deadline.mockRestore();
    }
  });

  it("works with a real HTTP endpoint and rejects redirects without contacting their target", async () => {
    let redirected = false;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/metrics")) {
        response.writeHead(302, { location: "/private" });
        response.end();
      } else {
        redirected = true;
        response.end(volumeMetrics());
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      expect(
        (await readPostgresStorageCapacity({ ...source, port: address.port }, now)).status,
      ).toBe("unavailable");
      expect(redirected).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
