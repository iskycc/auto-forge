const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
const MAXIMUM_DATA_BYTES = 32 * 1024;

export type BrowserTerminalMessage =
  | { schemaVersion: 1; type: "input"; data: string }
  | { schemaVersion: 1; type: "resize"; columns: number; rows: number }
  | { schemaVersion: 1; type: "close" };

export type AgentTerminalMessage =
  | { schemaVersion: 1; type: "ready"; sessionId: string }
  | { schemaVersion: 1; type: "output"; sessionId: string; data: string }
  | { schemaVersion: 1; type: "exit"; sessionId: string; exitCode?: number; signal?: string }
  | { schemaVersion: 1; type: "error"; sessionId: string; message: string };

export type AgentCommand =
  | { schemaVersion: 1; type: "open"; sessionId: string; columns: number; rows: number }
  | { schemaVersion: 1; type: "input"; sessionId: string; data: string }
  | { schemaVersion: 1; type: "resize"; sessionId: string; columns: number; rows: number }
  | { schemaVersion: 1; type: "close"; sessionId: string };

export type BrowserEvent =
  | { schemaVersion: 1; type: "ready" }
  | { schemaVersion: 1; type: "output"; data: string }
  | { schemaVersion: 1; type: "exit"; exitCode?: number; signal?: string }
  | { schemaVersion: 1; type: "error"; message: string };

export function parseBrowserMessage(raw: Buffer): BrowserTerminalMessage | null {
  const value = parseObject(raw);
  if (!value || value.schemaVersion !== 1 || typeof value.type !== "string") return null;
  if (value.type === "input" && validEncodedData(value.data)) {
    return { schemaVersion: 1, type: "input", data: value.data };
  }
  if (value.type === "resize" && validSize(value.columns, value.rows)) {
    return {
      schemaVersion: 1,
      type: "resize",
      columns: Number(value.columns),
      rows: Number(value.rows),
    };
  }
  if (value.type === "close") return { schemaVersion: 1, type: "close" };
  return null;
}

export function parseAgentMessage(raw: Buffer): AgentTerminalMessage | null {
  const value = parseObject(raw);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.type !== "string" ||
    !validIdentifier(value.sessionId)
  ) {
    return null;
  }
  if (value.type === "output" && validEncodedData(value.data)) {
    return { schemaVersion: 1, type: "output", sessionId: value.sessionId, data: value.data };
  }
  if (value.type === "ready") {
    return { schemaVersion: 1, type: "ready", sessionId: value.sessionId };
  }
  if (value.type === "error" && typeof value.message === "string" && value.message.length <= 500) {
    return { schemaVersion: 1, type: "error", sessionId: value.sessionId, message: value.message };
  }
  if (value.type === "exit") {
    const exitCode = value.exitCode;
    const signal = value.signal;
    if (
      (exitCode === undefined || (Number.isInteger(exitCode) && Number(exitCode) >= 0)) &&
      (signal === undefined || (typeof signal === "string" && signal.length <= 32))
    ) {
      return {
        schemaVersion: 1,
        type: "exit",
        sessionId: value.sessionId,
        ...(typeof exitCode === "number" ? { exitCode } : {}),
        ...(typeof signal === "string" ? { signal } : {}),
      };
    }
  }
  return null;
}

function parseObject(raw: Buffer): Record<string, unknown> | null {
  if (raw.byteLength === 0 || raw.byteLength > MAXIMUM_MESSAGE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validSize(columns: unknown, rows: unknown): columns is number {
  return (
    Number.isInteger(columns) &&
    Number(columns) >= 20 &&
    Number(columns) <= 500 &&
    Number.isInteger(rows) &&
    Number(rows) >= 5 &&
    Number(rows) <= 200
  );
}

function validEncodedData(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_DATA_BYTES * 2) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.byteLength(value, "base64") <= MAXIMUM_DATA_BYTES;
}
