import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = resolve("scripts/quality/download-acceptance-dependency.sh");
const content = Buffer.from("Pinned acceptance dependency\n");
const checksum = createHash("sha256").update(content).digest("hex");

async function withDownloadFixture(respond, verify) {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-dependency-download-"));
  const server = createServer(respond);
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await verify(`http://127.0.0.1:${address.port}/dependency`, directory);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("retries temporary gateway errors and installs only verified dependency bytes", async () => {
  let requests = 0;
  await withDownloadFixture(
    (request, response) => {
      assert.equal(request.headers.accept, "application/octet-stream");
      response.writeHead(++requests < 3 ? 504 : 200);
      response.end(requests < 3 ? "Gateway timeout" : content);
    },
    async (url, directory) => {
      const destination = join(directory, "dependency");
      await execute("bash", [script, url, checksum, destination], { timeout: 10_000 });
      assert.deepEqual(await readFile(destination), content);
      assert.equal(requests, 3);
      assert.deepEqual(await readdir(directory), ["dependency"]);
    },
  );
});

test("rejects altered bytes without replacing a prior file or leaving partial downloads", async () => {
  let requests = 0;
  await withDownloadFixture(
    (_request, response) => {
      requests++;
      response.end("Altered dependency");
    },
    async (url, directory) => {
      const destination = join(directory, "dependency");
      await writeFile(destination, content);
      await assert.rejects(execute("bash", [script, url, checksum, destination]));
      assert.equal(requests, 1);
      assert.deepEqual(await readFile(destination), content);
      assert.deepEqual(await readdir(directory), ["dependency"]);
    },
  );
});

test("does not retry permanent HTTP rejection or retain its response body", async () => {
  let requests = 0;
  await withDownloadFixture(
    (_request, response) => {
      requests++;
      response.writeHead(404);
      response.end("Not found");
    },
    async (url, directory) => {
      await assert.rejects(execute("bash", [script, url, checksum, join(directory, "dependency")]));
      assert.equal(requests, 1);
      assert.deepEqual(await readdir(directory), []);
    },
  );
});

test("stops after three retries when the gateway remains unavailable", async () => {
  let requests = 0;
  await withDownloadFixture(
    (_request, response) => {
      requests++;
      response.writeHead(504);
      response.end("Gateway timeout");
    },
    async (url, directory) => {
      await assert.rejects(
        execute("bash", [script, url, checksum, join(directory, "dependency")], {
          timeout: 10_000,
        }),
      );
      assert.equal(requests, 4);
      assert.deepEqual(await readdir(directory), []);
    },
  );
});
