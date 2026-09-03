type ApiErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    details?: unknown;
  };
};

export class ApiClientError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(input: {
    code: string;
    message: string;
    requestId?: string;
    status: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "ApiClientError";
    this.code = input.code;
    this.status = input.status;
    if (input.requestId !== undefined) this.requestId = input.requestId;
    if (input.details !== undefined) this.details = input.details;
  }
}

export async function readApiError(
  response: Response,
  fallbackMessage: string,
): Promise<ApiClientError | undefined> {
  if (response.ok) return undefined;
  const responseText = await response.text();
  try {
    const body = JSON.parse(responseText) as ApiErrorBody;
    return new ApiClientError({
      code: typeof body.error?.code === "string" ? body.error.code : "HTTP_REQUEST_FAILED",
      message: typeof body.error?.message === "string" ? body.error.message : fallbackMessage,
      status: response.status,
      ...(typeof body.error?.requestId === "string" ? { requestId: body.error.requestId } : {}),
      ...(body.error?.details !== undefined ? { details: body.error.details } : {}),
    });
  } catch {
    return new ApiClientError({
      code: "HTTP_REQUEST_FAILED",
      message: fallbackMessage,
      status: response.status,
    });
  }
}

export async function throwApiErrorResponse(
  response: Response,
  fallbackMessage: string,
): Promise<never> {
  const error = await readApiError(response, fallbackMessage);
  throw (
    error ??
    new ApiClientError({
      code: "UNEXPECTED_SUCCESS_RESPONSE",
      message: fallbackMessage,
      status: response.status,
    })
  );
}

export function isConcurrentModificationError(error: unknown): error is ApiClientError {
  if (!(error instanceof ApiClientError)) return false;
  return (
    error.code === "REVISION_CONFLICT" ||
    error.code === "PLATFORM_CONFIGURATION_CONFLICT" ||
    error.code === "CASE_SOURCE_SYNC_STALE" ||
    error.code.endsWith("_REVISION_CONFLICT")
  );
}

export async function readApiErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string | undefined> {
  return (await readApiError(response, fallbackMessage))?.message;
}
