import { caseDirectoryManifestSchema, type ReadModelQuery } from "@autoforge/contracts";
import type { ReadModelSnapshotService } from "@autoforge/application";
import { DomainError } from "@autoforge/domain";
import { z } from "zod";
import { readReadySnapshot } from "./read-ready-model";
import { boundedDetailResponse } from "./bounded-detail-response";

const cursorSchema = z.string().regex(/^[0-9a-f-]{36}:\d{1,8}$/);

export async function readDirectoryApiPage<T extends object>(input: {
  request: Request;
  service: ReadModelSnapshotService;
  query: ReadModelQuery;
  schema: { parse(value: unknown): T };
  empty: T;
}) {
  const rawCursor = new URL(input.request.url).searchParams.get("cursor");
  const cursor = rawCursor ? cursorSchema.parse(rawCursor).split(":") : undefined;
  const snapshot = await readReadySnapshot(input.service, input.query, input.request.signal);
  if (cursor && cursor[0] !== snapshot.generation)
    throw new DomainError("READ_MODEL_GENERATION_CONFLICT", "目录已更新，请从第一页重新读取。");
  const manifest = caseDirectoryManifestSchema.parse(snapshot.payload);
  const ordinal = cursor ? Number(cursor[1]) : 0;
  if (ordinal >= manifest.partCount && ordinal !== 0)
    throw new DomainError("READ_MODEL_GENERATION_CONFLICT", "目录页已过期，请从第一页重新读取。");
  const payload = manifest.partCount
    ? await input.service.part(snapshot.id, snapshot.generation!, ordinal)
    : input.empty;
  if (payload === null)
    throw new DomainError("READ_MODEL_GENERATION_CONFLICT", "目录已更新，请从第一页重新读取。");
  const part = input.schema.parse(payload);
  const result = {
    ...(Array.isArray(part) ? { items: part } : part),
    total: manifest.caseCount,
    ...(ordinal + 1 < manifest.partCount
      ? { nextCursor: `${snapshot.generation}:${ordinal + 1}` }
      : {}),
  };
  return boundedDetailResponse({
    summary: result,
    memberCount: 0,
    view: "summary",
    load: async () => result,
    pageUrl: new URL(input.request.url).pathname,
  });
}
