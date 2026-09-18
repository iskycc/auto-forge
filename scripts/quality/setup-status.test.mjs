import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { request } from "@playwright/test";
import { readSetupStatus } from "../../tests/e2e/support/setup-status.ts";

async function withSetupServer(handler, verify) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await request.newContext({
    baseURL: `http://127.0.0.1:${server.address().port}`,
  });
  try {
    await verify(client);
  } finally {
    await client.dispose();
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("setup read recovers one connection reset without replaying a test or a mutation", async () => {
  let requests = 0;
  await withSetupServer(
    (incoming, response) => {
      assert.equal(incoming.method, "GET");
      assert.equal(incoming.url, "/api/v1/auth/setup-status");
      requests += 1;
      if (requests === 1) incoming.socket.destroy();
      else response.end(JSON.stringify({ setupRequired: false }));
    },
    async (client) => {
      assert.equal(await readSetupStatus(client), false);
      assert.equal(requests, 2);
    },
  );
});

test("a new request context can recover a stale socket left by the preceding context", async () => {
  let previousSocket;
  let reusedStaleSocket = false;
  let setupReads = 0;
  await withSetupServer(
    (incoming, response) => {
      if (incoming.url === "/warm") {
        previousSocket = incoming.socket;
        response.end("ready");
        return;
      }
      setupReads += 1;
      if (incoming.socket === previousSocket) {
        reusedStaleSocket = true;
        incoming.socket.destroy();
        return;
      }
      response.end(JSON.stringify({ setupRequired: true }));
    },
    async (client) => {
      // The contexts have separate cookies but Playwright's driver shares its
      // HTTP agent. Close the first context to mirror a completed browser test.
      const warm = await client.get("/warm");
      const baseURL = new URL(warm.url()).origin;
      const nextClient = await request.newContext({ baseURL });
      await client.dispose();
      try {
        assert.equal(await readSetupStatus(nextClient), true);
        // A future driver may stop sharing the pool; a fresh connection should
        // also succeed without imposing a dependency on today's pooling bug.
        assert.equal(setupReads, reusedStaleSocket ? 2 : 1);
      } finally {
        await nextClient.dispose();
      }
    },
  );
});

test("persistent connection resets fail after one bounded recovery attempt", async () => {
  let requests = 0;
  await withSetupServer(
    (incoming) => {
      requests += 1;
      incoming.socket.destroy();
    },
    async (client) => {
      await assert.rejects(readSetupStatus(client), /socket hang up|ECONNRESET/);
      assert.equal(requests, 2);
    },
  );
});

test("setup read rejects service errors immediately without treating them as completed setup", async () => {
  let requests = 0;
  await withSetupServer(
    (_incoming, response) => {
      requests += 1;
      response.writeHead(503);
      response.end(JSON.stringify({ error: { message: "busy" } }));
    },
    async (client) => {
      await assert.rejects(readSetupStatus(client), /HTTP 503/);
      assert.equal(requests, 1);
    },
  );
});

test("setup read validates the response and accepts both setup states", async () => {
  for (const setupRequired of [true, false, "false", undefined]) {
    await withSetupServer(
      (_incoming, response) => {
        response.end(JSON.stringify({ setupRequired }));
      },
      async (client) => {
        if (typeof setupRequired === "boolean")
          assert.equal(await readSetupStatus(client), setupRequired);
        else await assert.rejects(readSetupStatus(client), /setupRequired/);
      },
    );
  }
});
