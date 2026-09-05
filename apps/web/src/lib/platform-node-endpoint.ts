import { DomainError } from "@autoforge/domain";
import { nodeLogRequestSchema } from "@autoforge/contracts";
import { readJsonBody } from "./api-response";
import { getPlatformServices } from "./services";
import { loadAppConfig } from "./config";

export async function handlePlatformNodeLogs(request: Request) {
  // Configuration is read before opening the Full adapters, so this endpoint cannot
  // cause a Lite installation to connect to external infrastructure.
  const config = loadAppConfig();
  if (config.mode !== "full" || !config.distributed || !config.nodeId) {
    throw new DomainError("PLATFORM_NODE_AUTH_REJECTED", "平台节点接口未启用。");
  }
  const { verifyNodeLogRequest, NODE_LOG_REQUEST_BYTES } = await import("@autoforge/db/postgres");
  const body: unknown = await readJsonBody(request, NODE_LOG_REQUEST_BYTES);
  const services = await getPlatformServices();
  const authentication = verifyNodeLogRequest(
    config.masterKey,
    config.nodeId,
    request.headers,
    JSON.stringify(body),
    services.clock.now().getTime(),
  );
  if (
    !services.platformNodes ||
    !services.nodeLogs ||
    !(await services.platformNodes.find(authentication.sourceNodeId))
  ) {
    throw new DomainError("PLATFORM_NODE_AUTH_REJECTED", "请求节点尚未登记。");
  }
  if (
    !(await services.runnerRequestLimiter.allow(
      `platform-node:nonce:v1:${authentication.nonce}`,
      1,
      60_000,
    ))
  ) {
    throw new DomainError("PLATFORM_NODE_AUTH_REJECTED", "节点请求已使用或过期。");
  }
  return services.nodeLogs.handlePeer(nodeLogRequestSchema.parse(body));
}
