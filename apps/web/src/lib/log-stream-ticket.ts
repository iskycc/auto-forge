import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAXIMUM_TICKET_BYTES = 4 * 1024;

export type LogStreamTicket = {
  schemaVersion: 1;
  attemptId: string;
  actorId: string;
  expiresAtEpochSeconds: number;
  nonce: string;
};

export function issueLogStreamTicket(
  secret: string,
  input: { attemptId: string; actorId: string; ttlSeconds: number; now?: Date },
): string {
  assertSecret(secret);
  if (!input.attemptId || !input.actorId || input.ttlSeconds < 1 || input.ttlSeconds > 600) {
    throw new Error("Log stream ticket input is invalid.");
  }
  const now = input.now ?? new Date();
  const ticket: LogStreamTicket = {
    schemaVersion: 1,
    attemptId: input.attemptId,
    actorId: input.actorId,
    expiresAtEpochSeconds: Math.floor(now.getTime() / 1000) + input.ttlSeconds,
    nonce: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return `${payload}.${signature(secret, payload)}`;
}

export function verifyLogStreamTicket(
  secret: string,
  encoded: string,
  now = new Date(),
): LogStreamTicket | null {
  assertSecret(secret);
  if (!encoded || encoded.length > MAXIMUM_TICKET_BYTES) return null;
  const [payload, suppliedSignature, extra] = encoded.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  const expected = Buffer.from(signature(secret, payload));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isTicket(parsed)) return null;
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (
      parsed.expiresAtEpochSeconds <= nowSeconds ||
      parsed.expiresAtEpochSeconds > nowSeconds + 600
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isTicket(value: unknown): value is LogStreamTicket {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.attemptId === "string" &&
    candidate.attemptId.length > 0 &&
    candidate.attemptId.length <= 128 &&
    typeof candidate.actorId === "string" &&
    candidate.actorId.length > 0 &&
    candidate.actorId.length <= 128 &&
    Number.isInteger(candidate.expiresAtEpochSeconds) &&
    typeof candidate.nonce === "string" &&
    candidate.nonce.length >= 16
  );
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update("autoforge-log-stream-ticket-v1\0")
    .update(payload)
    .digest("base64url");
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret) < 32) {
    throw new Error("Log stream ticket secret must contain at least 32 bytes.");
  }
}
