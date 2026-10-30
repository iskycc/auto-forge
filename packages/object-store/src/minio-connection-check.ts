import * as http from "node:http";
import * as https from "node:https";
import { randomUUID } from "node:crypto";
import { Client } from "minio";
import type { PlatformInfrastructureCheck } from "@autoforge/contracts/platform-infrastructure";

type Connection = Extract<PlatformInfrastructureCheck, { component: "minio" }>["connection"];

/** Checks actual object permissions using one uniquely named, bounded temporary object. */
export async function checkMinioConnection(connection: Connection): Promise<void> {
  const transport = connection.tls ? https : http;
  const agent = connection.tls
    ? new https.Agent({ keepAlive: false })
    : new http.Agent({ keepAlive: false });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const request: typeof http.request = ((
    options: http.RequestOptions,
    callback?: (response: http.IncomingMessage) => void,
  ) =>
    transport.request({ ...options, signal: controller.signal }, callback)) as typeof http.request;
  const client = new Client({
    endPoint: connection.host.replace(/^\[|\]$/g, ""),
    port: connection.port,
    useSSL: connection.tls,
    accessKey: connection.accessKey,
    secretKey: connection.secretKey,
    region: connection.region,
    transport: { request },
    transportAgent: agent,
    retryOptions: { disableRetry: true },
  });
  const key = `system/connection-check/${randomUUID()}.txt`;
  const expectedContent = Buffer.from("AutoForge connection check");
  let objectMayExist = false;
  let probeFailure: unknown;
  try {
    if (!(await client.bucketExists(connection.bucket)))
      throw Object.assign(new Error("Bucket missing"), { code: "NoSuchBucket" });
    objectMayExist = true;
    await client.putObject(connection.bucket, key, expectedContent);
    const stream = await client.getObject(connection.bucket, key);
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024) {
        stream.destroy();
        throw new Error("Unexpected probe object size");
      }
      chunks.push(Buffer.from(chunk));
    }
    if (!Buffer.concat(chunks).equals(expectedContent))
      throw new Error("Probe object content mismatch");
  } catch (cause) {
    probeFailure = cause;
    throw cause;
  } finally {
    clearTimeout(timeout);
    try {
      if (objectMayExist) {
        // Cleanup gets its own short deadline even if the read/write deadline elapsed.
        const cleanup = new Client({
          endPoint: connection.host.replace(/^\[|\]$/g, ""),
          port: connection.port,
          useSSL: connection.tls,
          accessKey: connection.accessKey,
          secretKey: connection.secretKey,
          region: connection.region,
          transport: {
            request: ((
              options: http.RequestOptions,
              callback?: (response: http.IncomingMessage) => void,
            ) =>
              transport.request(
                { ...options, signal: AbortSignal.timeout(3000) },
                callback,
              )) as typeof http.request,
          },
          transportAgent: agent,
          retryOptions: { disableRetry: true },
        });
        try {
          await cleanup.removeObject(connection.bucket, key);
        } catch (cleanupFailure) {
          throw Object.assign(
            new Error("MinIO connection check object cleanup failed", {
              cause: new AggregateError(
                probeFailure ? [probeFailure, cleanupFailure] : [cleanupFailure],
              ),
            }),
            { code: "CHECK_OBJECT_CLEANUP_FAILED" },
          );
        }
      }
    } finally {
      controller.abort();
      agent.destroy();
    }
  }
}
