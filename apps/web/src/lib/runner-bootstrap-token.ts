import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "v1";
const REINSTALL_TOKEN_VERSION = "v2";
const TOKEN_LIFETIME_SECONDS = 15 * 60;

export function issueRunnerBootstrapToken(
  masterKey: string,
  now: Date,
  replacementRunnerId?: string,
): string {
  const expiresAt = Math.floor(now.getTime() / 1_000) + TOKEN_LIFETIME_SECONDS;
  const nonce = randomBytes(24).toString("base64url");
  const payload = replacementRunnerId
    ? `${REINSTALL_TOKEN_VERSION}.${expiresAt}.${Buffer.from(replacementRunnerId, "utf8").toString("base64url")}.${nonce}`
    : `${TOKEN_VERSION}.${expiresAt}.${nonce}`;
  return `${payload}.${signature(payload, masterKey)}`;
}

export function verifyRunnerBootstrapToken(token: string, masterKey: string, now: Date): boolean {
  const parts = token.split(".");
  if (!validTokenShape(parts)) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt)) return false;
  const currentTimestamp = Math.floor(now.getTime() / 1_000);
  if (expiresAt < currentTimestamp || expiresAt > currentTimestamp + TOKEN_LIFETIME_SECONDS) {
    return false;
  }
  const payload = parts.slice(0, -1).join(".");
  return secureEqual(parts.at(-1) ?? "", signature(payload, masterKey));
}

/**
 * A reinstall token is issued only by the authenticated SSH installation flow.
 * It lets an Agent whose local identity file was lost recover the same logical
 * Runner id, so suites and queued batches do not remain bound to an abandoned id.
 */
export function replacementRunnerIdFromBootstrapToken(
  token: string,
  masterKey: string,
  now: Date,
): string | undefined {
  if (!verifyRunnerBootstrapToken(token, masterKey, now)) return undefined;
  const parts = token.split(".");
  if (parts[0] !== REINSTALL_TOKEN_VERSION) return undefined;
  try {
    const runnerId = Buffer.from(parts[2] ?? "", "base64url").toString("utf8");
    return runnerId.length >= 1 && runnerId.length <= 128 ? runnerId : undefined;
  } catch {
    return undefined;
  }
}

function validTokenShape(parts: string[]): boolean {
  return (
    (parts.length === 4 && parts[0] === TOKEN_VERSION) ||
    (parts.length === 5 && parts[0] === REINSTALL_TOKEN_VERSION && Boolean(parts[2]))
  );
}

function signature(payload: string, masterKey: string): string {
  return createHmac("sha256", Buffer.from(masterKey, "base64")).update(payload).digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
