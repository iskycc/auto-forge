import { createServer, request as createRequest } from "node:http";
import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [controlDirectory, listenPortValue, targetPortValue] = process.argv.slice(2);
if (!controlDirectory || !listenPortValue || !targetPortValue) {
  throw new Error("Usage: minio-fault-proxy.mjs CONTROL_DIR LISTEN_PORT TARGET_PORT");
}
const listenPort = parsePort(listenPortValue);
const targetPort = parsePort(targetPortValue);
const failureMarker = join(controlDirectory, "minio.fail-next-put");
const failureClaim = join(controlDirectory, "minio.fail-next-put.claimed");
const failureAcknowledgement = join(controlDirectory, "minio.fail-next-put.ack");
const readFailureMarker = join(controlDirectory, "minio.fail-get");
const readFailureAcknowledgement = join(controlDirectory, "minio.fail-get.ack");

const server = createServer(async (incoming, outgoing) => {
  if (incoming.method === "PUT" && (await claimFailure())) {
    incoming.resume();
    outgoing.writeHead(503, { "content-type": "text/plain", connection: "close" });
    outgoing.end("Injected one-shot MinIO PUT failure.\n");
    await writeFile(failureAcknowledgement, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return;
  }
  if (
    incoming.method === "GET" &&
    !incoming.url?.startsWith("/minio/health/") &&
    (await exists(readFailureMarker))
  ) {
    incoming.resume();
    outgoing.writeHead(503, { "content-type": "text/plain", connection: "close" });
    outgoing.end("Injected persistent MinIO GET failure.\n");
    await writeFile(readFailureAcknowledgement, `${new Date().toISOString()}\n`, {
      mode: 0o600,
    });
    return;
  }

  const proxied = createRequest(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  proxied.on("error", (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
    outgoing.end(`MinIO proxy error: ${error.message}\n`);
  });
  incoming.on("error", () => proxied.destroy());
  incoming.pipe(proxied);
});

server.listen(listenPort, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function claimFailure() {
  try {
    await rename(failureMarker, failureClaim);
    await readFile(failureClaim);
    await unlink(failureClaim);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}
