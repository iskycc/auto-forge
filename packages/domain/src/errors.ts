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
