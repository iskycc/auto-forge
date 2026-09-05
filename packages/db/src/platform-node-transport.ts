import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Clock } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import {
  nodeLogResponseSchema,
  type NodeLogRequest,
  type NodeLogResponse,
} from "@autoforge/contracts";

export const NODE_LOG_PATH = "/api/v1/internal/platform-logs";
export const NODE_LOG_REQUEST_BYTES = 3 * 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 40 * 1024 * 1024;
const REQUEST_LIFETIME_MS = 30_000;

export type NodeLogTransport = (
  node: { id: string; internalBaseUrl: string },
  request: NodeLogRequest,
) => Promise<NodeLogResponse>;

export function signNodeLogRequest(
  secret: string,
  sourceNodeId: string,
  targetNodeId: string,
  body: string,
  now = Date.now(),
) {
  const timestamp = String(now);
  const nonce = randomUUID();
  return {
    "content-type": "application/json",
    "x-autoforge-node": sourceNodeId,
    "x-autoforge-target-node": targetNodeId,
    "x-autoforge-node-time": timestamp,
    "x-autoforge-node-nonce": nonce,
    "x-autoforge-node-signature": signature(
      secret,
      sourceNodeId,
      targetNodeId,
      timestamp,
      nonce,
      body,
    ),
  };
}

export function verifyNodeLogRequest(
  secret: string,
  targetNodeId: string,
  headers: Headers,
  body: string,
  now = Date.now(),
): { sourceNodeId: string; nonce: string } {
  const sourceNodeId = headers.get("x-autoforge-node") ?? "";
  const target = headers.get("x-autoforge-target-node") ?? "";
  const timestamp = headers.get("x-autoforge-node-time") ?? "";
  const nonce = headers.get("x-autoforge-node-nonce") ?? "";
  const supplied = headers.get("x-autoforge-node-signature") ?? "";
  if (
    target !== targetNodeId ||
    !/^[0-9a-f-]{36}$/.test(sourceNodeId) ||
    !/^[0-9a-f-]{36}$/.test(nonce) ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > REQUEST_LIFETIME_MS ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(
      Buffer.from(supplied, "hex"),
      Buffer.from(signature(secret, sourceNodeId, target, timestamp, nonce, body), "hex"),
    )
  ) {
    throw new DomainError("PLATFORM_NODE_AUTH_REJECTED", "平台节点请求认证失败。");
  }
  return { sourceNodeId, nonce };
}

function signature(
  secret: string,
  source: string,
  target: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(
      [
        "autoforge-node-logs-v1",
        "POST",
        NODE_LOG_PATH,
        source,
        target,
        timestamp,
        nonce,
        createHash("sha256").update(body).digest("hex"),
      ].join("\n"),
    )
    .digest("hex");
}

export function createNodeLogTransport(
  secret: string,
  sourceNodeId: string,
  clock: Clock,
): NodeLogTransport {
  return async (node, request) => {
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > NODE_LOG_REQUEST_BYTES)
      throw new DomainError("REQUEST_BODY_TOO_LARGE", "节点日志请求过大。");
    let response: Response;
    try {
      response = await fetch(new URL(NODE_LOG_PATH, node.internalBaseUrl), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: signNodeLogRequest(secret, sourceNodeId, node.id, body, clock.now().getTime()),
        body,
      });
      const payload: unknown = JSON.parse(await readNodeResponse(response));
      if (!response.ok) {
        const conflict =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof payload.error === "object" &&
          payload.error !== null &&
          "code" in payload.error &&
          payload.error.code === "LOG_CHUNK_CONFLICT";
        const code = conflict ? "LOG_CHUNK_CONFLICT" : "PLATFORM_LOG_NODE_UNAVAILABLE";
        throw new DomainError(
          code,
          conflict
            ? "相同日志序号已保存不同内容。"
            : `日志节点 ${node.id} 暂不可用，请检查节点地址与服务状态。`,
        );
      }
      const parsed = nodeLogResponseSchema.parse(payload);
      if (parsed.nodeId !== node.id) throw new Error("Peer returned a different node identity.");
      return parsed;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "PLATFORM_LOG_NODE_UNAVAILABLE",
        `无法连接日志节点 ${node.id}，请检查节点地址、网络和共享密钥。`,
        { cause: error },
      );
    }
  };
}

async function readNodeResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error("Peer response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAXIMUM_RESPONSE_BYTES) throw new Error("Peer response exceeds its size limit.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
