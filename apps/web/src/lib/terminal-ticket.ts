import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TICKET_SCHEMA_VERSION = 1;
const MAXIMUM_TICKET_BYTES = 4 * 1024;

export type TerminalTicketRole = "agent" | "browser";

export type TerminalTicket = {
  schemaVersion: 1;
  role: TerminalTicketRole;
  runnerId: string;
  sessionId?: string;
  actorId?: string;
  columns?: number;
  rows?: number;
  expiresAtEpochSeconds: number;
  nonce: string;
};

type IssueTerminalTicketInput = {
  role: TerminalTicketRole;
  runnerId: string;
  sessionId?: string;
  actorId?: string;
  columns?: number;
  rows?: number;
  ttlSeconds: number;
  now?: Date;
};

export function issueTerminalTicket(secret: string, input: IssueTerminalTicketInput): string {
  assertSecret(secret);
  if (!input.runnerId || input.ttlSeconds < 1 || input.ttlSeconds > 600) {
    throw new Error("Terminal ticket input is invalid.");
  }
  if (
    input.role === "browser" &&
    (!input.sessionId || !input.actorId || !validTerminalSize(input.columns, input.rows))
  ) {
    throw new Error("Browser terminal tickets require a session ID and valid dimensions.");
  }
  const now = input.now ?? new Date();
  const ticket: TerminalTicket = {
    schemaVersion: TICKET_SCHEMA_VERSION,
    role: input.role,
    runnerId: input.runnerId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.columns ? { columns: input.columns } : {}),
    ...(input.rows ? { rows: input.rows } : {}),
    expiresAtEpochSeconds: Math.floor(now.getTime() / 1000) + input.ttlSeconds,
    nonce: randomBytes(16).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return `${payload}.${signature(secret, payload)}`;
}

export function verifyTerminalTicket(
  secret: string,
  encodedTicket: string,
  now = new Date(),
): TerminalTicket | null {
  assertSecret(secret);
  if (!encodedTicket || encodedTicket.length > MAXIMUM_TICKET_BYTES) return null;
  const segments = encodedTicket.split(".");
  if (segments.length !== 2) return null;
  const [payload, suppliedSignature] = segments;
  if (!payload || !suppliedSignature) return null;
  const expectedSignature = signature(secret, payload);
  const expectedBytes = Buffer.from(expectedSignature);
  const suppliedBytes = Buffer.from(suppliedSignature);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isTerminalTicket(parsed)) return null;
    const nowEpochSeconds = Math.floor(now.getTime() / 1000);
    if (
      parsed.expiresAtEpochSeconds <= nowEpochSeconds ||
      parsed.expiresAtEpochSeconds > nowEpochSeconds + 600
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function verifyTerminalUpgradeTicket(
  secret: string,
  headers: {
    authorization?: string | string[] | undefined;
    "sec-websocket-protocol"?: string | string[] | undefined;
  },
  now = new Date(),
): TerminalTicket | null {
  const authorization = firstHeaderValue(headers.authorization) ?? "";
  if (authorization.startsWith("Bearer ")) {
    const ticket = verifyTerminalTicket(secret, authorization.slice(7).trim(), now);
    if (ticket?.role === "agent") return ticket;
  }
  const protocols = headerValues(headers["sec-websocket-protocol"])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  const encodedTicket = protocols
    .find((value) => value.startsWith("autoforge-ticket."))
    ?.slice("autoforge-ticket.".length);
  return encodedTicket ? verifyTerminalTicket(secret, encodedTicket, now) : null;
}

function isTerminalTicket(value: unknown): value is TerminalTicket {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const role = candidate.role;
  const sessionId = candidate.sessionId;
  return (
    candidate.schemaVersion === TICKET_SCHEMA_VERSION &&
    (role === "agent" || role === "browser") &&
    typeof candidate.runnerId === "string" &&
    candidate.runnerId.length > 0 &&
    candidate.runnerId.length <= 128 &&
    typeof candidate.expiresAtEpochSeconds === "number" &&
    Number.isInteger(candidate.expiresAtEpochSeconds) &&
    typeof candidate.nonce === "string" &&
    candidate.nonce.length >= 16 &&
    ((role === "agent" &&
      sessionId === undefined &&
      candidate.columns === undefined &&
      candidate.rows === undefined) ||
      (role === "browser" &&
        typeof sessionId === "string" &&
        sessionId.length > 0 &&
        typeof candidate.actorId === "string" &&
        candidate.actorId.length > 0 &&
        candidate.actorId.length <= 128 &&
        validTerminalSize(candidate.columns, candidate.rows)))
  );
}

function validTerminalSize(columns: unknown, rows: unknown): columns is number {
  return (
    Number.isInteger(columns) &&
    Number(columns) >= 20 &&
    Number(columns) <= 500 &&
    Number.isInteger(rows) &&
    Number(rows) >= 5 &&
    Number(rows) <= 200
  );
}

function headerValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return headerValues(value)[0];
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update("autoforge-terminal-ticket-v1\0")
    .update(payload)
    .digest("base64url");
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret) < 32) {
    throw new Error("Terminal ticket secret must contain at least 32 bytes.");
  }
}
