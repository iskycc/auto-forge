import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 执行机协议高频写路径（领取/日志/完成）的组合根快路径。请求不进入 Next.js
 * 路由，直接在原始 HTTP 层完成传输处理，再经 globalThis 上注册的桥接器调用
 * 与 Route Handler 相同的应用服务：鉴权、限流、校验、错误结构完全一致。
 * 本模块不得导入工作区包（服务器构建使用 NodeNext，工作区源码为 Bundler 解析），
 * 业务逻辑全部位于桥接器实现（src/lib/runner-fast-path-bridge.ts）。
 */
export type RunnerFastPathRoute =
  | { kind: "complete"; attemptId: string }
  | { kind: "logs"; attemptId: string }
  | { kind: "claims"; runnerId: string };

export interface RunnerFastPathContext {
  /** 原始请求体；超过该路由上限时为 null，由桥接器映射 413 错误。 */
  rawBody: Buffer | null;
  bearerToken: string;
  runnerIdHeader: string | null;
  requestId: string;
}

export interface RunnerFastPathBridge {
  dispatch(
    route: RunnerFastPathRoute,
    context: RunnerFastPathContext,
  ): Promise<{ status: number; payload: unknown }>;
}

export class FastPathUnavailable extends Error {
  constructor() {
    super("执行机协议快路径尚未注册，回退 Next.js 路由。");
  }
}

const COMPLETE_PATH = /^\/api\/v1\/run-attempts\/([^/]+)\/complete$/;
const LOGS_PATH = /^\/api\/v1\/run-attempts\/([^/]+)\/logs$/;
const CLAIMS_PATH = /^\/api\/v1\/runner-agents\/([^/]+)\/claims$/;

// 与 @autoforge/contracts 的 RUNNER_*_BODY_LIMIT_BYTES 保持一致；
// 本模块无法导入工作区包，常量在此镜像并随协议变更同步更新。
const COMPLETE_BODY_LIMIT_BYTES = 512 * 1024;
const LOGS_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const CLAIMS_BODY_LIMIT_BYTES = 64 * 1024;

const globalHandles = globalThis as typeof globalThis & {
  __autoforgeRunnerFastPath?: RunnerFastPathBridge;
};

export function matchRunnerFastPath(
  method: string | undefined,
  url: string | undefined,
): RunnerFastPathRoute | null {
  if (method !== "POST" || !url) return null;
  const queryIndex = url.indexOf("?");
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const complete = COMPLETE_PATH.exec(pathname);
  if (complete) {
    const attemptId = decodeSegment(complete[1]!);
    return attemptId === null ? null : { kind: "complete", attemptId };
  }
  const logs = LOGS_PATH.exec(pathname);
  if (logs) {
    const attemptId = decodeSegment(logs[1]!);
    return attemptId === null ? null : { kind: "logs", attemptId };
  }
  const claims = CLAIMS_PATH.exec(pathname);
  if (claims) {
    const runnerId = decodeSegment(claims[1]!);
    return runnerId === null ? null : { kind: "claims", runnerId };
  }
  return null;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export async function handleRunnerFastPath(
  route: RunnerFastPathRoute,
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const bridge = globalHandles.__autoforgeRunnerFastPath;
  if (!bridge) throw new FastPathUnavailable();
  const rawBody = await readBoundedBody(request, bodyLimitFor(route));
  const header = request.headers["x-autoforge-runner-id"];
  const runnerIdHeader = (Array.isArray(header) ? header[0] : header)?.trim() || null;
  const { status, payload } = await bridge.dispatch(route, {
    rawBody,
    bearerToken: bearerToken(request),
    runnerIdHeader,
    requestId,
  });
  writeJson(response, status, payload, requestId, !request.complete);
  if (!request.complete) request.destroy();
}

function bodyLimitFor(route: RunnerFastPathRoute): number {
  switch (route.kind) {
    case "claims":
      return CLAIMS_BODY_LIMIT_BYTES;
    case "logs":
      return LOGS_BODY_LIMIT_BYTES;
    case "complete":
      return COMPLETE_BODY_LIMIT_BYTES;
  }
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  const authorization = Array.isArray(header) ? header[0] : header;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
}

async function readBoundedBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer | null> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return null;
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    totalBytes += buffer.byteLength;
    if (totalBytes > maximumBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  requestId: string,
  closeConnection: boolean,
): void {
  if (response.headersSent) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-request-id": requestId,
    ...(closeConnection ? { connection: "close" } : {}),
  });
  response.end(body);
}
