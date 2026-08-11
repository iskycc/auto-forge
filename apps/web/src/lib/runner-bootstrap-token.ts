import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "v1";
const TOKEN_LIFETIME_SECONDS = 15 * 60;

export function issueRunnerBootstrapToken(masterKey: string, now: Date): string {
  const expiresAt = Math.floor(now.getTime() / 1_000) + TOKEN_LIFETIME_SECONDS;
  const nonce = randomBytes(24).toString("base64url");
  const payload = `${TOKEN_VERSION}.${expiresAt}.${nonce}`;
  return `${payload}.${signature(payload, masterKey)}`;
}

export function verifyRunnerBootstrapToken(token: string, masterKey: string, now: Date): boolean {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt)) return false;
  const currentTimestamp = Math.floor(now.getTime() / 1_000);
  if (expiresAt < currentTimestamp || expiresAt > currentTimestamp + TOKEN_LIFETIME_SECONDS) {
    return false;
  }
  const payload = parts.slice(0, 3).join(".");
  return secureEqual(parts[3] ?? "", signature(payload, masterKey));
}

function signature(payload: string, masterKey: string): string {
  return createHmac("sha256", Buffer.from(masterKey, "base64")).update(payload).digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
