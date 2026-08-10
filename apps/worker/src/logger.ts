import type { WorkerLogger } from "@autoforge/application";

export const logger: WorkerLogger & {
  warn(message: string, details?: Record<string, unknown>): void;
} = {
  info: (message, details = {}) => write("info", message, details),
  warn: (message, details = {}) => write("warn", message, details),
  error: (message, details = {}) => write("error", message, details),
};

function write(
  level: "info" | "warn" | "error",
  message: string,
  details: Record<string, unknown>,
): void {
  const output = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...details,
  });
  if (level === "error") process.stderr.write(`${output}\n`);
  else process.stdout.write(`${output}\n`);
}
