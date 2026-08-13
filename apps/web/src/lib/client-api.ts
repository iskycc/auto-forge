type ApiErrorBody = { error?: { message?: unknown } };

export async function readApiErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string | undefined> {
  const responseText = await response.text();
  if (response.ok) return undefined;
  try {
    const body = JSON.parse(responseText) as ApiErrorBody;
    return typeof body.error?.message === "string" ? body.error.message : fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}
