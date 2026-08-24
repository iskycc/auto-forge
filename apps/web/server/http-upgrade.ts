import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

type UpgradeRequest = Pick<IncomingMessage, "headers">;
type UpgradeSocket = Pick<Duplex, "end">;

const H2C_REJECTION_BODY = JSON.stringify({
  error: {
    code: "H2C_UPGRADE_UNSUPPORTED",
    message: "明文 HTTP/2 升级不受支持，请使用 HTTP/1.1 或通过 HTTPS 访问。",
  },
});

/**
 * Node 把 h2c 请求送入 upgrade 事件而不是普通 HTTP handler。Next.js 只处理
 * WebSocket upgrade，因此必须在这里给出完整响应，不能让客户端收到无字节断连。
 */
export function rejectH2cUpgrade(request: UpgradeRequest, socket: UpgradeSocket): boolean {
  const upgrade = request.headers.upgrade;
  const protocol = Array.isArray(upgrade) ? upgrade[0] : upgrade;
  if (protocol?.trim().toLowerCase() !== "h2c") return false;

  socket.end(
    [
      "HTTP/1.1 400 Bad Request",
      "Connection: close",
      "Cache-Control: no-store",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(H2C_REJECTION_BODY)}`,
      "",
      H2C_REJECTION_BODY,
    ].join("\r\n"),
  );
  return true;
}
