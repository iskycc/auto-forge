import {
  apiErrorSchema,
  caseDirectoryManifestSchema,
  readModelStatusSchema,
  type CaseDirectoryManifest,
  type ReadModelStatus,
} from "@autoforge/contracts";

export type DirectoryProjection = {
  status: ReadModelStatus;
  manifest: CaseDirectoryManifest | null;
  synchronized?: boolean;
};

export async function readDirectoryProjection(
  baseId: string,
  filters: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DirectoryProjection> {
  const response = await fetcher(`/api/v1/read-models/${baseId}/directory?${filters}`, {
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await directoryResponseError(response));
  const payload = (await response.json()) as {
    status: unknown;
    manifest: unknown;
    synchronized?: boolean;
  };
  return {
    status: readModelStatusSchema.parse(payload.status),
    synchronized: payload.synchronized !== false,
    manifest:
      payload.manifest === null
        ? null
        : caseDirectoryManifestSchema.passthrough().parse(payload.manifest),
  };
}

export async function directoryResponseError(response: Response): Promise<string> {
  const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.error.message : `读取目录失败（HTTP ${response.status}）。`;
}
