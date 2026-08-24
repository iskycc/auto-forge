import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1;
export const RUN_PROGRESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_TTL_MS = RUN_PROGRESS_TOKEN_TTL_SECONDS * 1_000;

type RunProgressClaims = {
  version: 1;
  batchId: string;
  expiresAt: number;
};

export function issueRunProgressToken(
  masterKey: string,
  batchId: string,
  now = new Date(),
  ttlMs = DEFAULT_TTL_MS,
): string {
  const claims: RunProgressClaims = {
    version: TOKEN_VERSION,
    batchId,
    expiresAt: now.getTime() + ttlMs,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${signature(masterKey, payload)}`;
}

export function verifyRunProgressToken(
  masterKey: string,
  token: string,
  expectedBatchId: string,
  now = new Date(),
): boolean {
  const [payload, suppliedSignature, extra] = token.split(".");
  if (!payload || !suppliedSignature || extra) return false;
  const expectedSignature = signature(masterKey, payload);
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<RunProgressClaims>;
    return (
      claims.version === TOKEN_VERSION &&
      claims.batchId === expectedBatchId &&
      typeof claims.expiresAt === "number" &&
      Number.isSafeInteger(claims.expiresAt) &&
      claims.expiresAt > now.getTime()
    );
  } catch {
    return false;
  }
}

function signature(masterKey: string, payload: string): string {
  return createHmac("sha256", masterKey).update(`run-progress:${payload}`).digest("base64url");
}
