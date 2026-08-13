export class DomainError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options?: ErrorOptions & { details?: unknown }) {
    super(message, options);
    this.name = "DomainError";
    this.code = code;
    this.details = options?.details;
  }
}

// Bundlers can duplicate workspace packages across module graphs, which breaks
// `instanceof`; match the stable shape instead, mirroring isJarInspectionError.
export function isDomainError(error: unknown): error is DomainError {
  return (
    error instanceof Error &&
    error.name === "DomainError" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
